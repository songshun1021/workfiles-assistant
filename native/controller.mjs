import { randomUUID } from 'node:crypto';
import { parseHostMessage, parseHelperMessage, ProtocolError } from './protocol.mjs';

const busy = phase => ['preparing', 'transcribing', 'working'].includes(phase);
const listenPhase = phase => ['listening', 'question'].includes(phase);
const invalid = (code, message) => { throw new ProtocolError(code, message); };

// The real main injects only its own accelerator operations and window lifecycle.
// This state machine has no media/device/OS APIs and is exercised without a GUI.
export function createNativeController({ send, onState = () => {}, onShow = () => {}, onHide = () => {}, register, unregister, uuid = randomUUID, platform = process.platform, electronVersion = 'unknown' }) {
  let initialized = false, disposed = false, shortcut = '', title = '工作文件助手', registered = false, current = null, signalId = 0;
  const owned = new Set(), seen = new Set();
  const emit = message => send(parseHelperMessage({ v: 1, ...message }));
  const requireOpen = id => {
    if (disposed || !current || current.id !== id || !current.visible || current.closed) invalid('STALE_ACTIVATION', 'Activation is no longer current');
    return current;
  };
  function snapshot() {
    if (!current) return Object.freeze({ activationId: null, phase: 'ready', message: '准备就绪', capture: false, listen: false, visible: false, canPrepare: false });
    const c = current;
    return Object.freeze({ activationId: c.id, phase: c.phase, capture: c.captureIntent && c.armed && c.visible, listen: c.listen && c.visible, visible: c.visible,
      message: c.message, ...(c.detail === undefined ? {} : { detail: c.detail }), canPrepare: c.canPrepare,
      ...(c.progress === undefined ? {} : { progress: c.progress }), ...(c.signal ? { signal: c.signal, signalId: c.signalId } : {}) });
  }
  const publish = () => onState(snapshot());
  function reportReady(configurationId) { emit({ type: 'ready', shortcut, registered, platform, electronVersion, ...(configurationId ? { configurationId } : {}) }); }
  function configure(next, configurationId) {
    if (current?.visible && !current.closed) {
      emit({ type: 'notice', code: 'SHORTCUT_BUSY', message: '请先结束并收起语音任务，再修改快捷键。' });
      reportReady(configurationId); return;
    }
    if (next === shortcut && registered) { reportReady(configurationId); return; }
    let success = false;
    try { success = register(next, () => api.shortcut()) === true; } catch { /* invalid/occupied accelerator; keep the old registration */ }
    if (success) {
      const previous = shortcut; owned.add(next); shortcut = next; registered = true;
      if (previous && previous !== next && owned.has(previous)) { unregister(previous); owned.delete(previous); }
    } else {
      if (!shortcut) shortcut = next;
      emit({ type: 'notice', code: 'SHORTCUT_UNAVAILABLE', message: '系统快捷键注册失败；可能已被占用或快捷键无效。现有快捷键未被替换。' });
    }
    reportReady(configurationId);
  }
  function revealCurrent() {
    if (!current || !current.visible || current.closed) return;
    onShow({ activationId: current.id, title, focus: current.revealed });
    publish();
  }
  function hide(reason = 'hide') {
    if (!current || current.closed || !current.visible) return;
    const c = current; c.armed = false; c.captureIntent = false; c.listen = false; c.submitAllowed = false; c.visible = false; c.signal = undefined;
    publish(); onHide({ activationId: c.id, reason });
  }
  function activate(id, source, capture) {
    if (seen.has(id)) invalid('STALE_ACTIVATION', 'Activation IDs cannot be reused');
    hide('replacement');
    seen.add(id);
    // Parent and native use fresh UUIDs. Bound long-lived replay bookkeeping;
    // current-ID checks still apply to every IPC/state/audio message.
    if (seen.size > 256) seen.delete(seen.values().next().value);
    current = { id, armed: capture, captureIntent: capture, phase: capture ? 'preparing' : 'ready', message: capture ? '正在准备，请稍候' : '准备就绪', listen: false, visible: true, closed: false, canPrepare: false,
      revealed: !capture, capturing: false, submitAllowed: false, utterances: new Set() };
    publish();
    // The initial recording panel must not steal the original foreground app before Host snapshot.
    onShow({ activationId: id, title, focus: !capture });
    emit({ type: 'activated', activationId: id, source, capture });
  }
  function acceptUtterance(c, utteranceId) {
    if (c.utterances.has(utteranceId)) invalid('DUPLICATE_UTTERANCE', 'Utterance has already been submitted');
    if (c.utterances.size >= 128) invalid('UTTERANCE_LIMIT', 'Please start a new activation');
    c.utterances.add(utteranceId);
  }
  const api = {
    snapshot,
    mayCapture() { return !disposed && !!current && current.visible && !current.closed && current.armed && current.captureIntent && current.listen && listenPhase(current.phase); },
    isCapturing() { return current?.capturing === true; },
    handleHost(input) {
      const m = parseHostMessage(input);
      if (disposed) invalid('DISPOSED', 'Native helper is shutting down');
      if (m.type === 'shutdown') { api.dispose(); return; }
      if (m.type === 'init') {
        if (initialized) invalid('ALREADY_INITIALIZED', 'Native helper has already been initialized');
        initialized = true; title = m.title; configure(m.shortcut); return;
      }
      if (!initialized) invalid('NOT_INITIALIZED', 'Expected init before commands');
      if (m.type === 'configure') { configure(m.shortcut, m.configurationId); return; }
      if (m.type === 'toggle') { api.shortcut('host'); return; }
      if (m.type === 'show') {
        if (current?.id === m.activationId && current.visible && !current.closed) {
          if (m.capture !== current.armed) invalid('ACTIVATION_REARM', 'A different capture intent requires a new activation');
          revealCurrent(); return;
        }
        if (seen.has(m.activationId)) invalid('STALE_ACTIVATION', 'Activation IDs cannot be reused');
        if (current?.visible && !current.closed && (m.capture === false || busy(current.phase))) { revealCurrent(); return; }
        activate(m.activationId, 'host', m.capture); return;
      }
      if (m.type === 'hide') { if (m.activationId !== undefined) requireOpen(m.activationId); hide(); return; }
      if (m.type === 'state') {
        const c = requireOpen(m.activationId);
        c.phase = m.phase; c.message = m.message ?? ''; c.detail = m.detail; c.canPrepare = m.canPrepare ?? false; c.progress = m.progress; c.signal = undefined;
        // Questions are display-only. Answering requires a new shortcut/record gesture and UUID.
        c.listen = m.listen === true && m.phase === 'listening' && c.armed;
        c.captureIntent = c.armed && c.listen;
        c.submitAllowed = c.armed && c.listen;
        publish();
        if (!c.revealed) { c.revealed = true; onShow({ activationId: c.id, title, focus: true }); }
        return;
      }
    },
    shortcut(source = 'shortcut') {
      if (!initialized || disposed) return;
      if (!['shortcut', 'host'].includes(source)) invalid('INVALID_SOURCE', 'Invalid shortcut source');
      if (current?.visible && !current.closed) {
        const c = current;
        if (busy(c.phase) || c.signal === 'stop-submit' && c.submitAllowed) { revealCurrent(); return; }
        if (c.capturing || (c.listen && c.captureIntent)) {
          // Preserve one final submission after permission/capture has been
          // revoked. The renderer handles this signal before capture:false.
          c.captureIntent = false; c.listen = false; c.signal = 'stop-submit'; c.signalId = ++signalId;
          publish(); return;
        }
      }
      activate(uuid(), source, true);
    },
    renderer(kind, payload) {
      if (!['audio', 'text', 'action', 'capture'].includes(kind)) invalid('INVALID_RENDERER_METHOD', 'Unsupported renderer method');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.hasOwn(payload, 'v') || Object.hasOwn(payload, 'type')) invalid('INVALID_RENDERER_PAYLOAD', 'Expected a method-specific payload');
      const m = parseHelperMessage({ ...payload, v: 1, type: kind });
      const c = requireOpen(m.activationId);
      if (kind === 'capture') {
        if (m.active && !api.mayCapture()) invalid('CAPTURE_NOT_ARMED', 'Capture is not permitted');
        if (c.capturing !== m.active) { c.capturing = m.active; emit(m); }
        return;
      }
      if (kind === 'audio') {
        if (!c.armed || !c.submitAllowed) invalid('AUDIO_NOT_ARMED', 'No current audio submission is permitted');
        acceptUtterance(c, m.utteranceId); c.armed = false; c.submitAllowed = false; c.captureIntent = false; c.listen = false; c.signal = undefined;
        c.phase = 'transcribing'; c.message = '正在识别…'; publish(); emit(m); return;
      }
      if (kind === 'text') {
        if (busy(c.phase)) invalid('BUSY', 'A task is already in progress');
        acceptUtterance(c, m.utteranceId); c.armed = false; c.submitAllowed = false; c.captureIntent = false; c.listen = false; c.signal = undefined;
        c.phase = 'working'; c.message = '正在处理…'; publish(); emit(m); return;
      }
      if (m.name === 'retry') {
        if (busy(c.phase)) invalid('BUSY', 'Wait for or cancel the current task');
        // The trusted explicit record/retry button is a fresh human activation,
        // not a state update that silently arms an old generation.
        activate(uuid(), 'panel', true); return;
      }
      if (m.name === 'prepare') {
        if (busy(c.phase) || c.capturing || c.listen) invalid('BUSY', 'Preparation requires an idle panel');
        c.armed = false; c.captureIntent = false; c.submitAllowed = false; publish(); emit(m); return;
      }
      emit(m); hide(m.name);
    },
    closed(activationId) {
      if (!current || current.id !== activationId || current.closed) return;
      const c = current;
      if (c.capturing) { c.capturing = false; emit({ type: 'capture', activationId: c.id, active: false }); }
      c.armed = false; c.captureIntent = false; c.submitAllowed = false; c.listen = false; c.visible = false; c.closed = true;
      publish(); emit({ type: 'closed', activationId });
    },
    dispose() {
      if (disposed) return;
      hide('shutdown'); disposed = true;
      for (const accelerator of owned) { try { unregister(accelerator); } catch { /* only our registrations */ } }
      owned.clear(); registered = false;
    },
  };
  return Object.freeze(api);
}
