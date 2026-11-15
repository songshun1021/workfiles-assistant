import { randomUUID } from 'node:crypto';
import { validateShortcut } from '../native/protocol.mjs';

export const MAX_VOICE_AUDIO_BYTES = 2 * 1024 * 1024;
const READY = new Set(['ready', 'standby']);
const PREPARING = new Set(['checking', 'downloading', 'loading', 'waking', 'cancelling']);
const cut = (value, max = 1000) => String(value ?? '').slice(0, max);
function raceAbort(pending, signal) {
  if (signal.aborted) { void Promise.resolve(pending).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function scopedCall(signal, operation) {
  return raceAbort(Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), signal);
}

/** The private transport accepts complete bounded mono PCM16 WAVs, never partial transcripts. */
export function validateVoiceWave(encoded) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_VOICE_AUDIO_BYTES / 3) * 4 || !encoded.length) throw new Error('录音为空或过长。');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_VOICE_AUDIO_BYTES || bytes.toString('base64') !== encoded || bytes.length < 44) throw new Error('录音编码无效。');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) throw new Error('录音不是完整的 WAV。');
  let format, dataBytes, parts = 0, cursor = 12;
  while (cursor < bytes.length) {
    if (++parts > 32 || cursor + 8 > bytes.length) throw new Error('录音分块无效。');
    const name = bytes.toString('ascii', cursor, cursor + 4), size = bytes.readUInt32LE(cursor + 4);
    const from = cursor + 8, end = from + size;
    if (end > bytes.length || end + (size & 1) > bytes.length) throw new Error('录音尚未完整结束。');
    if (name === 'fmt ') {
      if (format || size !== 16) throw new Error('录音格式无效。');
      format = { pcm: bytes.readUInt16LE(from), channels: bytes.readUInt16LE(from + 2), rate: bytes.readUInt32LE(from + 4), byteRate: bytes.readUInt32LE(from + 8), align: bytes.readUInt16LE(from + 12), bits: bytes.readUInt16LE(from + 14) };
    } else if (name === 'data') {
      if (dataBytes !== undefined) throw new Error('录音数据重复。');
      dataBytes = size;
    }
    cursor = end + (size & 1);
  }
  if (!format || format.pcm !== 1 || format.channels !== 1 || format.bits !== 16 || format.rate !== 16000 || format.align !== 2 || format.byteRate !== 32000 || !dataBytes || dataBytes % 2 || dataBytes / 32000 > 20.05) throw new Error('请使用不超过 20 秒的单声道录音。');
  return { durationSeconds: dataBytes / 32000, bytes: bytes.length };
}

/** Feature-owned scheduling only. Model context and candidates remain in the real Session log. */
export function createVoiceCoordinator({ runtime, speech, session, getConfig = () => ({}), getDocumentStatus = async () => ({ enabled: true, roots: ['configured'] }),
  captureCurrentContext, releaseCurrentContext = () => {}, correctTranscript, contextCaptureMs = 2000, shortcutConfigureMs = 3000,
  onState = () => {}, timeoutMs = 90000, now = Date.now }) {
  const lifetime = new AbortController();
  const pending = new Set(), activations = new Set();
  let transport, startPromise, followTask, disposal, disposed = false, active = null, catalog = null;
  let registration = { registered: false, shortcut: getConfig().shortcut || 'CommandOrControl+Shift+Space' };
  let lastError = null, preparationOwner = null, pendingConfiguration = null;
  const live = value => !disposed && active === value && !value.signal.aborted;
  const track = promise => {
    const task = Promise.resolve(promise);
    pending.add(task); task.catch(() => {}).finally(() => pending.delete(task));
    return task;
  };
  function releaseContext(value) {
    const context = value.context;
    value.context = undefined;
    context?.release();
  }
  async function captureContext(value) {
    if (!value.captureWanted || typeof captureCurrentContext !== 'function') return;
    const controller = new AbortController();
    const signal = AbortSignal.any([value.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new Error('当前资料线索读取超时。')), Math.max(1, Math.min(2500, contextCaptureMs)));
    let token, kept = false, expired = false, released = false;
    const release = () => {
      if (released || token == null) return;
      released = true;
      // The callback is a private Host capability; never send this token to IPC/status.
      track(scopedCall(AbortSignal.timeout(1000), () => releaseCurrentContext(token)).catch(() => {}));
    };
    const request = Promise.resolve().then(() => { signal.throwIfAborted(); return captureCurrentContext(signal); });
    void request.then(result => { token = result; if (expired && !kept) release(); }, () => {});
    try {
      const result = await raceAbort(request, signal);
      if (live(value) && !signal.aborted && result != null) { kept = true; value.context = { token: result, release }; }
    } catch { /* Optional context never blocks ordinary voice/file lookup. */ }
    finally { expired = true; clearTimeout(timer); if (!kept) release(); }
  }
  function publish(value, phase, fields = {}) {
    if (!live(value)) return;
    value.phase = phase;
    const state = { v: 1, type: 'state', activationId: value.id, phase, ...fields };
    if (state.message !== undefined) state.message = cut(state.message);
    if (state.detail !== undefined) state.detail = cut(state.detail);
    value.state = state;
    transport?.send(state);
    onState(status());
  }
  function failure(value, error) {
    if (!live(value)) return;
    value.captureWanted = false; value.waitingForSpeech = false; value.busy = false;
    releaseContext(value);
    lastError = cut(error?.message || error || '这次操作没有完成。');
    publish(value, 'error', { message: lastError, listen: false });
  }
  function selected(snapshot = catalog) {
    const id = getConfig().providerId || 'sensevoice-local';
    return snapshot?.providers?.find(provider => provider.id === id);
  }
  function acceptCatalog(snapshot) {
    catalog = snapshot;
    if (preparationOwner && snapshot?.providers?.some(provider => provider.id === preparationOwner && READY.has(provider.preparation?.phase))) preparationOwner = null;
  }
  function applyReadiness(value) {
    if (!live(value) || value.starting || !value.documentsReady || !value.waitingForSpeech || value.busy) return;
    const provider = selected();
    if (!provider) { failure(value, new Error('本地语音识别尚未接入，请在资料助手设置中检查。')); return; }
    const preparation = provider.preparation || { phase: 'unprepared' };
    if (READY.has(preparation.phase)) {
      value.waitingForSpeech = false;
      if (now() > value.armDeadline || now() < value.armedAt) value.captureWanted = false;
      if (!value.captureWanted) releaseContext(value);
      if (value.captureWanted) publish(value, 'listening', { message: '我在听，说完就会执行', listen: true, canPrepare: false });
      else publish(value, 'ready', { message: '准备好了，按一下录音或快捷键开始', listen: false, canPrepare: false });
    } else if (PREPARING.has(preparation.phase)) {
      if (preparation.phase === 'downloading') { value.captureWanted = false; releaseContext(value); }
      const progress = preparation.totalBytes > 0 && Number.isFinite(preparation.completedBytes) ? Math.max(0, Math.min(1, preparation.completedBytes / preparation.totalBytes)) : undefined;
      publish(value, 'preparing', { message: preparation.phase === 'downloading' ? '正在准备本地语音模型' : '正在检查和加载语音模型', detail: preparation.phase === 'downloading' ? `${Math.round((preparation.completedBytes || 0) / 1048576)}${preparation.totalBytes > 0 ? ` / ${Math.round(preparation.totalBytes / 1048576)}` : ''} MB` : '只需首次准备；此时不会录音。', ...(progress === undefined ? {} : { progress }), listen: false, canPrepare: false });
    } else {
      value.captureWanted = false; releaseContext(value);
      publish(value, preparation.phase === 'failed' ? 'error' : 'ready', { message: preparation.phase === 'failed' ? '语音模型尚未准备完成' : '首次使用，需要准备本地语音', detail: preparation.phase === 'failed' ? cut(preparation.message || '可以重试，已校验的文件会复用。') : '本地模型约 239 MB。准备时不录音，完成后由你按一下开始。', canPrepare: provider.location === 'host-local', listen: false });
    }
  }
  async function checkDocuments(value, signal = value.signal) {
    const scope = await scopedCall(signal, () => getDocumentStatus(signal));
    if (!live(value)) return false;
    if (scope.activityAllowed !== true) {
      if (!scope.enabled) throw new Error('资料查找已暂停，请先在设置中恢复。');
      if (!scope.roots?.length) throw new Error('请先在设置中选择允许查找的资料文件夹。');
    }
    value.documentsReady = true;
    return true;
  }
  function retire(reason = 'cancelled', hide = true) {
    const value = active;
    if (!value) return;
    active = null; value.captureWanted = false;
    value.controller.abort(new Error(reason));
    releaseContext(value);
    session.cancel();
    if (hide) transport?.send({ v: 1, type: 'hide', activationId: value.id });
    onState(status());
  }
  async function begin(message) {
    if (disposed || activations.has(message.activationId)) return;
    activations.add(message.activationId);
    if (activations.size > 128) activations.delete(activations.values().next().value);
    retire('superseded', false);
    const controller = new AbortController();
    const armedAt = now();
    const value = { id: message.activationId, controller, signal: AbortSignal.any([controller.signal, lifetime.signal]), captureWanted: message.capture === true, armedAt, armDeadline: armedAt + 8000, documentsReady: false, waitingForSpeech: true, busy: false, starting: true, context: undefined, phase: 'checking', seen: new Set(), captured: false };
    active = value;
    try {
      if (!await checkDocuments(value)) return;
      await captureContext(value);
      if (!live(value)) return;
      value.starting = false;
      // The first state is the native focus/reveal boundary, after optional snapshot has settled.
      publish(value, 'preparing', { message: '正在检查语音状态', listen: false });
      const snapshot = await scopedCall(value.signal, () => speech.catalog());
      if (!live(value)) return;
      acceptCatalog(snapshot); value.phase = 'checking'; applyReadiness(value);
    } catch (error) { failure(value, error); }
  }
  async function prepare(value) {
    if (!live(value) || value.busy) return;
    // Preparation is not a recording gesture. Even a long download must never turn the mic on later.
    value.captureWanted = false; value.waitingForSpeech = true; value.phase = 'preparing';
    releaseContext(value);
    try {
      acceptCatalog(await scopedCall(value.signal, () => speech.catalog()));
      if (!live(value)) return;
      const provider = selected();
      if (!provider || provider.location !== 'host-local') throw new Error('这个入口只会准备已选择的本地识别器。');
      if (READY.has(provider.preparation?.phase)) { value.phase = 'checking'; applyReadiness(value); return; }
      if (!PREPARING.has(provider.preparation?.phase)) preparationOwner = provider.id;
      publish(value, 'preparing', { message: '正在准备本地语音模型', detail: '准备完成后，按一下录音开始。现在不会使用麦克风。', listen: false, canPrepare: false });
      await scopedCall(value.signal, () => speech.prepare(provider.id));
    } catch (error) { failure(value, error); }
  }
  async function execute(message, audio) {
    const value = active;
    if (!value || !live(value) || value.starting || value.busy || value.seen.has(message.utteranceId)) return;
    if (audio && (!value.captureWanted || !['listening', 'question'].includes(value.phase))) return;
    value.seen.add(message.utteranceId);
    if (value.seen.size > 128) value.seen.delete(value.seen.values().next().value);
    const operation = { utteranceId: message.utteranceId };
    value.operation = operation; value.busy = true; value.waitingForSpeech = false;
    const taskSignal = AbortSignal.any([value.signal, AbortSignal.timeout(timeoutMs)]);
    let encoded, text;
    const utteranceId = message.utteranceId;
    try {
      if (!await checkDocuments(value, taskSignal)) return;
      if (audio) {
        encoded = message.wavBase64;
        message = null;
        validateVoiceWave(encoded);
        publish(value, 'transcribing', { message: '正在识别你刚才的话', listen: false });
        let transcript;
        try { transcript = await scopedCall(taskSignal, () => speech.transcribe({ audioBase64: encoded, providerId: getConfig().providerId || 'sensevoice-local', language: getConfig().language || 'auto' }, taskSignal)); }
        finally { encoded = undefined; }
        if (!live(value)) return;
        text = transcript?.text;
      } else {
        value.captureWanted = false;
        text = message.text; message = null;
      }
      taskSignal.throwIfAborted();
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('没有听清完整的指令，请再说一次。');
      text = text.trim();
      // Repair what the microphone heard before the Agent sees it. The repaired sentence
      // becomes the panel title, so the user can read "this is what I got" while the task
      // runs. A correction that fails, times out or reads like a different request is
      // discarded by correctTranscript itself — the raw transcript is always the floor.
      let heard = text;
      if (audio && typeof correctTranscript === 'function') {
        // Stays in the recognition phase on purpose: from the user's side this is still
        // "it is working out what I said", and a second label would only add noise.
        heard = await correctTranscript(text, taskSignal).catch(() => text) || text;
        if (!live(value)) return;
      }
      publish(value, 'working', { message: heard, listen: false });
      const contextToken = value.context?.token;
      const result = await scopedCall(taskSignal, () => session.run(heard, { signal: taskSignal, utteranceId, ...(contextToken == null ? {} : { contextToken }) }));
      taskSignal.throwIfAborted();
      if (!live(value)) return;
      value.busy = false;
      if (!result || !['done', 'clarify', 'not_found', 'error'].includes(result.status) || typeof result.say !== 'string' || !result.say.trim()) throw new Error('助手没有返回完整结果，请重试。');
      // A successful Session adapter owns/released its bound context token. Never reopen a mic for a question.
      value.context = undefined;
      value.captureWanted = false;
      if (result.status === 'clarify') publish(value, 'question', { message: result.say, detail: '', listen: false });
      else {
        value.captureWanted = false;
        publish(value, result.status === 'error' ? 'error' : result.status === 'not_found' ? 'ready' : 'done', { message: result.say, detail: '', listen: false });
      }
    } catch (error) {
      // A retired request must never cancel a newer activation using this same Agent.
      if (live(value) && value.operation === operation) {
        session.cancel();
        failure(value, taskSignal.aborted && !value.signal.aborted ? new Error('这次处理超时，已停止后续任务。可以再试一次。') : error);
      }
    } finally {
      encoded = undefined;
      if (value.operation === operation) { value.busy = false; value.operation = undefined; }
    }
  }
  function receive(message) {
    if (disposed || !message || message.v !== 1) return;
    if (message.type === 'ready') {
      registration = { registered: message.registered, shortcut: message.shortcut, platform: message.platform, electronVersion: message.electronVersion };
      if (pendingConfiguration?.sent && message.configurationId === pendingConfiguration.id) pendingConfiguration.resolve({ ...registration });
      onState(status()); return;
    }
    if (message.type === 'activated') {
      pendingConfiguration?.reject(new Error('语音任务已开始，请结束并收起后再修改快捷键。'));
      track(begin(message)); return;
    }
    if (message.type === 'notice' || message.type === 'fatal') {
      lastError = cut(message.message);
      if (message.type === 'fatal') retire('native failure');
      onState(status()); return;
    }
    const value = active;
    if (!value || !live(value) || message.activationId !== value.id) return;
    if (message.type === 'audio' || message.type === 'text') { track(execute(message, message.type === 'audio')); return; }
    if (message.type === 'capture') { value.captured = message.active; onState(status()); return; }
    if (message.type === 'closed') { retire('window closed', false); return; }
    if (message.type === 'action') {
      if (message.name === 'prepare') track(prepare(value));
      else if (message.name === 'cancel' || message.name === 'dismiss') {
        const owned = preparationOwner; preparationOwner = null;
        retire('user cancelled');
        if (owned) track(scopedCall(AbortSignal.timeout(2000), () => speech.cancelPreparation(owned)).catch(() => {}));
      }
    }
  }
  async function configureShortcut(shortcut, { signal } = {}) {
    try { validateShortcut(shortcut); }
    catch { throw new Error('请选择安全的组合快捷键；不能使用单独的 Esc、普通字符或常见系统操作键。'); }
    if (disposed) throw new Error('语音入口已停用。');
    if (active || pendingConfiguration) throw new Error('请先结束并收起语音任务，再修改快捷键。');
    const controller = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    let resolve, reject;
    const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
    void ready.catch(() => {});
    const request = { id: randomUUID(), resolve, reject, sent: false };
    pendingConfiguration = request;
    const timer = setTimeout(() => controller.abort(new Error('快捷键注册核实超时；未确认保存，请查看实际快捷键状态后重试。')), Math.max(1, Math.min(10000, shortcutConfigureMs)));
    try {
      await scopedCall(combined, () => start());
      combined.throwIfAborted();
      if (active || !transport || disposed) throw new Error('语音任务未处于空闲状态，请收起后再修改。');
      request.sent = true;
      if (transport.send({ v: 1, type: 'configure', shortcut, configurationId: request.id }) === false) throw new Error('快捷键设置未送达原生组件。');
      const actual = await raceAbort(ready, combined);
      combined.throwIfAborted();
      if (actual.registered !== true || actual.shortcut !== shortcut) throw new Error('这个快捷键不可用，原有快捷键已保留。');
      lastError = null; onState(status());
      return status();
    } finally {
      clearTimeout(timer);
      if (pendingConfiguration === request) pendingConfiguration = null;
    }
  }
  function status() {
    return { ...registration, running: !!transport && !disposed, phase: active?.phase || 'idle', microphoneActive: active?.captured === true, sessionId: session.sessionId || null, lastError, backgroundListening: false, active: active ? { activationId: active.id, phase: active.phase, busy: active.busy } : null };
  }
  async function start() {
    if (disposed) throw new Error('语音入口已停用。');
    if (startPromise) return startPromise;
    startPromise = (async () => {
      transport = await runtime.start({ initial: { v: 1, type: 'init', shortcut: getConfig().shortcut || 'CommandOrControl+Shift+Space', title: '工作资料语音' }, onMessage: receive, onExit(error) { transport = undefined; startPromise = undefined; lastError = cut(error?.message || '桌面语音入口已退出。'); pendingConfiguration?.reject(new Error('原生语音组件已退出，无法核实快捷键。')); retire('native exit', false); onState(status()); } });
      if (disposed) { await transport?.dispose(); transport = undefined; return; }
      if (active?.state) transport.send(active.state);
      if (speech.follow) followTask = (async () => {
        let iterator;
        try {
          iterator = speech.follow(lifetime.signal)[Symbol.asyncIterator]();
          while (!lifetime.signal.aborted) {
            const next = await scopedCall(lifetime.signal, () => iterator.next());
            if (next.done) break;
            acceptCatalog(next.value); if (active) applyReadiness(active);
          }
        } catch (error) { if (!lifetime.signal.aborted) { lastError = cut(error?.message); onState(status()); } }
        finally { void Promise.resolve().then(() => iterator?.return?.()).catch(() => {}); }
      })();
      return status();
    })();
    try { return await startPromise; }
    catch (error) { startPromise = undefined; lastError = cut(error.message); throw error; }
  }
  return {
    start, receive, status,
    async open({ capture = false } = {}) {
      await start();
      if (disposed || !transport) throw new Error('桌面语音入口不可用。');
      if (capture === true) {
        transport.send({ v: 1, type: 'toggle' });
        return status();
      }
      const activationId = randomUUID();
      transport.send({ v: 1, type: 'show', activationId, capture: false });
      return { ...status(), requestedActivationId: activationId };
    },
    cancel() { retire('cancelled'); },
    configureShortcut(shortcut, options) { return track(configureShortcut(shortcut, options)); },
    async settled() { await Promise.allSettled([...pending].filter(task => task !== undefined)); },
    dispose() {
      if (disposal) return disposal;
      const starting = startPromise;
      disposal = (async () => {
        retire('feature disabled'); disposed = true; lifetime.abort(new Error('语音入口已停用。'));
        const owned = preparationOwner, native = transport; preparationOwner = null;
        // A provider's preparation cleanup must not delay stopping the real window and Agent.
        await Promise.allSettled([
          Promise.resolve().then(() => session.dispose()),
          Promise.resolve().then(() => native?.dispose()),
          owned ? scopedCall(AbortSignal.timeout(2000), () => speech.cancelPreparation(owned)) : undefined,
        ]);
        transport = undefined;
        await Promise.allSettled([...pending, followTask]);
        if (starting) await raceAbort(starting, AbortSignal.timeout(12000)).catch(() => {});
      })();
      return disposal;
    },
  };
}
