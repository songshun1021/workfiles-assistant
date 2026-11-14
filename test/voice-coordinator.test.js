import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createVoiceCoordinator, validateVoiceWave, MAX_VOICE_AUDIO_BYTES } from '../lib/voice-coordinator.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred(fallback) {
  let resolve, reject, settled = false;
  const promise = new Promise((yes, no) => {
    resolve = value => { if (!settled) { settled = true; yes(value); } };
    reject = error => { if (!settled) { settled = true; no(error); } };
  });
  return { promise, resolve, reject, release: () => resolve(fallback) };
}
function catalog(phase = 'ready', extra = {}) {
  return { providers: [{ id: 'sensevoice-local', location: 'host-local', preparation: { phase, ...extra } }] };
}
function wave(samples = 320, rate = 16000) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}
function feed() {
  const queue = [];
  let waiting, closed = false;
  const wake = value => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(value); } else queue.push(value); };
  return {
    push: snapshot => wake(snapshot),
    close() { closed = true; wake(null); },
    async *follow(signal) {
      const abort = () => wake(null);
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (!closed && !signal.aborted) {
          const next = queue.length ? queue.shift() : await new Promise(resolve => { waiting = resolve; });
          if (!next || closed || signal.aborted) return;
          yield next;
        }
      } finally { signal.removeEventListener('abort', abort); }
    },
  };
}

// No native subprocess, real speech service, model, Agent or document provider is used.
function harness(t, options = {}) {
  const sent = [], calls = { starts: [], transcribes: [], runs: [], prepares: [], cancelPreparations: [], documentSignals: [], catalog: 0, cancels: 0, sessionDisposes: 0, runtimeDisposes: 0 };
  const updates = feed(), held = [];
  let currentCatalog = options.catalog || catalog();
  let documents = { enabled: true, roots: ['explicitly-authorized-fixture'] };
  let callbacks;
  const transport = { send(message) { sent.push(structuredClone(message)); return true; }, async dispose() { calls.runtimeDisposes++; } };
  const speech = {
    async catalog() { calls.catalog++; return options.getCatalog ? options.getCatalog() : currentCatalog; },
    async prepare(providerId) { calls.prepares.push(providerId); return options.prepare?.(providerId); },
    async cancelPreparation(providerId) { calls.cancelPreparations.push(providerId); },
    transcribe(input, signal) { calls.transcribes.push({ input, signal }); return options.transcribe ? options.transcribe(input, signal) : Promise.resolve({ text: '打开预算文档' }); },
    follow: signal => updates.follow(signal),
  };
  const session = {
    sessionId: 'voice-dedicated-fixture',
    run(text, request) { calls.runs.push({ text, ...request }); return options.run ? options.run(text, request) : Promise.resolve({ status: 'done', say: '已请求系统打开预算文档。' }); },
    cancel() { calls.cancels++; },
    async dispose() { calls.sessionDisposes++; },
  };
  const coordinator = createVoiceCoordinator({
    runtime: { async start(value) { callbacks = value; calls.starts.push(value.initial); return transport; } },
    speech, session, timeoutMs: options.timeoutMs || 90000, now: options.now,
    captureCurrentContext: options.captureCurrentContext, releaseCurrentContext: options.releaseCurrentContext,
    contextCaptureMs: options.contextCaptureMs, shortcutConfigureMs: options.shortcutConfigureMs,
    getConfig: () => ({ providerId: 'sensevoice-local', language: 'auto', shortcut: 'CommandOrControl+Shift+Space' }),
    async getDocumentStatus(signal) { calls.documentSignals.push(signal); return options.getDocumentStatus ? options.getDocumentStatus(signal) : documents; },
  });
  const h = {
    coordinator, sent, calls, transport, session,
    hold(fallback) { const value = deferred(fallback); held.push(value); return value; },
    setDocuments(value) { documents = value; },
    setCatalog(value) { currentCatalog = value; updates.push(value); },
    receive: message => coordinator.receive({ v: 1, ...message }),
    states: () => sent.filter(message => message.type === 'state'),
    async activate(id = 'activation-a', capture = true, source = 'shortcut') {
      await coordinator.start();
      coordinator.receive({ v: 1, type: 'activated', activationId: id, capture, source });
      await coordinator.settled();
      return id;
    },
    audio(id = 'activation-a', utteranceId = 'utterance-1', wavBase64 = wave().toString('base64')) {
      coordinator.receive({ v: 1, type: 'audio', activationId: id, utteranceId, wavBase64 });
    },
    text(text = '打开预算文档', id = 'activation-a', utteranceId = 'typed-1') {
      coordinator.receive({ v: 1, type: 'text', activationId: id, utteranceId, text });
    },
    exit(error = new Error('fixture exit')) { callbacks.onExit(error); },
    async dispose() {
      const closing = coordinator.dispose();
      for (const item of held) item.release();
      updates.close();
      await closing;
    },
  };
  t.after(() => h.dispose());
  return h;
}

test('startup and peek do not grant listen or invoke speech/Agent work', async t => {
  const h = harness(t);
  const first = await h.coordinator.start();
  assert.equal(first.phase, 'idle');
  assert.equal(first.backgroundListening, false);
  assert.equal(h.calls.catalog, 0);
  assert.deepEqual(h.sent, [], 'runtime owns the initial init write');
  const peek = await h.coordinator.open();
  const show = h.sent.at(-1);
  assert.equal(show.type, 'show');
  assert.equal(show.capture, false);
  assert.equal(show.activationId, peek.requestedActivationId);
  assert.equal(h.coordinator.status().active, null, 'show is not proof that native activated');
  await h.activate(show.activationId, false, 'host');
  assert.equal(h.coordinator.status().phase, 'ready');
  assert.ok(h.states().every(state => state.listen !== true));
  assert.equal(h.calls.transcribes.length, 0);
  assert.equal(h.calls.runs.length, 0);
});

test('record launch preserves explicit capture intent but waits for native activated confirmation', async t => {
  const h = harness(t);
  const result = await h.coordinator.open({ capture: true });
  assert.deepEqual(h.sent.at(-1), { v: 1, type: 'toggle' });
  assert.equal(result.active, null);
  assert.equal(h.coordinator.status().phase, 'idle');
  await h.activate('native-activation', true, 'host');
  assert.equal(h.states().at(-1).listen, true);
});

test('document authorization must finish before any Host listen grant', async t => {
  let permission;
  const h = harness(t, { getDocumentStatus: () => permission.promise });
  permission = h.hold({ enabled: true, roots: ['fixture'] });
  await h.coordinator.start();
  h.receive({ type: 'activated', activationId: 'activation-a', capture: true, source: 'shortcut' });
  await turn();
  assert.equal(h.calls.catalog, 0);
  assert.ok(h.states().every(state => state.listen !== true));
  assert.equal(h.calls.documentSignals.length, 1);
  permission.resolve({ enabled: true, roots: ['fixture'] });
  await h.coordinator.settled();
  assert.equal(h.states().at(-1).phase, 'listening');
  assert.equal(h.states().at(-1).listen, true);
});

test('disabled documents and empty allowlists fail closed before speech readiness', async t => {
  for (const documents of [{ enabled: false, roots: ['fixture'] }, { enabled: true, roots: [] }]) {
    const h = harness(t);
    h.setDocuments(documents);
    await h.activate();
    assert.equal(h.coordinator.status().phase, 'error');
    assert.equal(h.calls.catalog, 0);
    assert.ok(h.states().every(state => state.listen !== true));
  }
});

test('model preparation is explicit and its completion cannot arm the microphone', async t => {
  const h = harness(t, { catalog: catalog('unprepared') });
  await h.activate();
  assert.equal(h.states().at(-1).canPrepare, true);
  assert.equal(h.calls.prepares.length, 0);
  h.receive({ type: 'action', activationId: 'activation-a', name: 'prepare' });
  await h.coordinator.settled();
  assert.deepEqual(h.calls.prepares, ['sensevoice-local']);
  assert.equal(h.states().at(-1).phase, 'preparing');
  h.setCatalog(catalog('downloading', { completedBytes: 25, totalBytes: 100 }));
  await turn();
  assert.equal(h.states().at(-1).progress, 0.25);
  h.setCatalog(catalog('ready'));
  await turn();
  assert.equal(h.coordinator.status().phase, 'ready');
  assert.equal(h.states().at(-1).listen, false);
  assert.ok(h.states().every(state => state.listen !== true));
});

test('background preparation updates can grant listen only to the still-armed current activation', async t => {
  const h = harness(t, { catalog: catalog('loading') });
  await h.activate();
  assert.equal(h.states().at(-1).phase, 'preparing');
  assert.ok(h.states().every(state => state.listen !== true));
  h.setCatalog(catalog('ready'));
  await turn();
  assert.equal(h.states().at(-1).phase, 'listening');
  assert.equal(h.states().at(-1).listen, true);
});

test('readiness honors the eight-second arm lease and rejects expired or backwards-clock grants', async t => {
  for (const { elapsed, listen } of [
    { elapsed: 7999, listen: true }, { elapsed: 8000, listen: true },
    { elapsed: 8001, listen: false }, { elapsed: -1, listen: false },
  ]) {
    let time = 100000;
    const h = harness(t, { catalog: catalog('loading'), now: () => time });
    await h.activate();
    assert.equal(h.states().at(-1).listen, false);
    time += elapsed;
    h.setCatalog(catalog('ready'));
    await turn();
    assert.equal(h.states().at(-1).listen, listen, `readiness after ${elapsed}ms`);
    assert.equal(h.coordinator.status().phase, listen ? 'listening' : 'ready');
    if (!listen) {
      h.audio();
      await h.coordinator.settled();
      assert.equal(h.calls.transcribes.length, 0, 'an expired intent cannot submit audio');
    }
  }
});

test('download or first-use unprepared state consumes arm even when readiness follows immediately', async t => {
  for (const phase of ['downloading', 'unprepared']) {
    let time = 100000;
    const h = harness(t, { catalog: catalog(phase), now: () => time });
    await h.activate();
    assert.equal(h.states().at(-1).listen, false);
    time += 100;
    h.setCatalog(catalog('ready'));
    await turn();
    assert.equal(h.coordinator.status().phase, 'ready');
    assert.equal(h.states().at(-1).listen, false, `${phase} readiness is not a fresh recording gesture`);
    h.audio();
    await h.coordinator.settled();
    assert.equal(h.calls.transcribes.length, 0);
    assert.equal(h.calls.runs.length, 0);
  }
});

test('audio requires an armed listening/question activation, never a peek or preparation phase', async t => {
  const h = harness(t);
  await h.activate('peek', false, 'host');
  h.audio('peek');
  await h.coordinator.settled();
  assert.equal(h.calls.transcribes.length, 0);
  await h.activate('armed', true);
  h.audio('peek', 'stale');
  await h.coordinator.settled();
  assert.equal(h.calls.transcribes.length, 0);
  assert.equal(h.coordinator.status().active.activationId, 'armed');
});

test('only one complete final WAV is transcribed and admitted; duplicate utterance IDs are ignored', async t => {
  const h = harness(t);
  await h.activate();
  h.receive({ type: 'notice', code: 'partial', message: 'not an Agent input' });
  h.audio();
  h.audio();
  await h.coordinator.settled();
  assert.equal(h.calls.transcribes.length, 1);
  assert.equal(h.calls.transcribes[0].input.providerId, 'sensevoice-local');
  assert.equal(h.calls.runs.length, 1);
  assert.equal(h.calls.runs[0].text, '打开预算文档');
  assert.equal(h.calls.runs[0].utteranceId, 'utterance-1');
  assert.ok(h.calls.runs[0].signal instanceof AbortSignal);
  assert.equal(h.states().at(-1).phase, 'done');
  assert.equal(h.states().at(-1).listen, false);
  h.audio();
  await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 1);
});

test('a busy turn is serialized rather than partially admitting another utterance', async t => {
  let transcript;
  const h = harness(t, { transcribe: () => transcript.promise });
  transcript = h.hold({ text: '预算文档' });
  await h.activate();
  h.audio();
  await turn();
  h.audio('activation-a', 'utterance-2');
  h.text('额外输入', 'activation-a', 'typed-2');
  await turn();
  assert.equal(h.calls.transcribes.length, 1);
  assert.equal(h.calls.runs.length, 0);
  transcript.resolve({ text: '预算文档' });
  await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 1);
});

test('malformed, partial, stereo and over-duration WAVs never reach ASR/Agent', async t => {
  const stereo = wave(); stereo.writeUInt16LE(2, 22);
  const incomplete = wave().subarray(0, 50);
  for (const encoded of ['not base64', stereo.toString('base64'), incomplete.toString('base64'), wave(320801).toString('base64')]) {
    const h = harness(t);
    await h.activate();
    h.audio('activation-a', 'invalid-wave', encoded);
    await h.coordinator.settled();
    assert.equal(h.calls.transcribes.length, 0);
    assert.equal(h.calls.runs.length, 0);
    assert.equal(h.coordinator.status().phase, 'error');
    assert.equal(h.states().at(-1).listen, false);
  }
});

test('document scope is rechecked for every utterance, not inherited from launch', async t => {
  const h = harness(t);
  await h.activate();
  h.setDocuments({ enabled: false, roots: ['fixture'] });
  h.audio();
  await h.coordinator.settled();
  assert.equal(h.calls.documentSignals.length, 2);
  assert.equal(h.calls.transcribes.length, 0);
  assert.equal(h.calls.runs.length, 0);
  assert.equal(h.coordinator.status().phase, 'error');
});

test('clarification retains dedicated Session but requires a fresh explicit activation to record an answer', async t => {
  let runs = 0;
  const h = harness(t, { run: async () => ++runs === 1 ? { status: 'clarify', say: '要今年还是去年的预算？' } : { status: 'done', say: '已请求打开今年的预算。' } });
  await h.activate();
  h.audio();
  await h.coordinator.settled();
  assert.equal(h.states().at(-1).phase, 'question');
  assert.equal(h.states().at(-1).listen, false);
  assert.equal(h.coordinator.status().sessionId, 'voice-dedicated-fixture');
  h.audio('activation-a', 'must-not-auto-record');
  await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 1);
  await h.activate('activation-answer', true, 'shortcut');
  h.audio('activation-answer', 'follow-up');
  await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 2);
  assert.equal(h.calls.starts.length, 1);
  assert.equal(h.states().at(-1).phase, 'done');
});

test('not-found feedback remains ready for reading and never reopens the microphone', async t => {
  const message = '没有找到该主题的工作资料。请补充年份、文件类型或项目名称，再手动重试。';
  const h = harness(t, { run: async () => ({ status: 'not_found', say: message }) });
  await h.activate(); h.audio(); await h.coordinator.settled();
  assert.equal(h.coordinator.status().phase, 'ready');
  assert.equal(h.coordinator.status().active.activationId, 'activation-a', 'retain the real result panel rather than retiring it');
  assert.equal(h.states().at(-1).message, message);
  assert.equal(h.states().at(-1).listen, false);
  assert.equal(h.calls.runtimeDisposes, 0);
  h.setCatalog(catalog('ready'));
  await turn();
  h.audio('activation-a', 'must-not-auto-follow');
  await h.coordinator.settled();
  assert.equal(h.calls.transcribes.length, 1);
  assert.equal(h.calls.runs.length, 1);
  assert.equal(h.states().at(-1).message, message, 'a provider readiness update must not erase the retained explanation');
  assert.equal(h.states().at(-1).listen, false);
});

test('typed fallback works without speech readiness and never arms follow-up autoMic, including a peek', async t => {
  const h = harness(t, { catalog: catalog('unprepared'), run: async () => ({ status: 'clarify', say: '哪个文件夹？' }) });
  await h.activate('peek', false, 'host');
  h.text('请找预算', 'peek');
  await h.coordinator.settled();
  assert.equal(h.calls.transcribes.length, 0);
  assert.equal(h.calls.runs.length, 1);
  assert.equal(h.states().at(-1).phase, 'question');
  assert.equal(h.states().at(-1).listen, false);
  assert.ok(h.states().every(state => state.listen !== true));
});

test('switching an armed activation to explicit text disarms later clarification', async t => {
  const h = harness(t, { run: async () => ({ status: 'clarify', say: '要哪个版本？' }) });
  await h.activate();
  h.text();
  await h.coordinator.settled();
  assert.equal(h.states().at(-1).phase, 'question');
  assert.equal(h.states().at(-1).listen, false);
});

test('empty ASR and malformed Agent deliveries fail without submitting a partial prompt', async t => {
  const empty = harness(t, { transcribe: async () => ({ text: '  ' }) });
  await empty.activate(); empty.audio(); await empty.coordinator.settled();
  assert.equal(empty.calls.runs.length, 0);
  assert.equal(empty.coordinator.status().phase, 'error');
  const malformed = harness(t, { run: async () => ({ status: 'clarify', say: '' }) });
  await malformed.activate(); malformed.audio(); await malformed.coordinator.settled();
  assert.equal(malformed.coordinator.status().phase, 'error');
  assert.equal(malformed.states().at(-1).listen, false);
});

test('cancel aborts an uncooperative late ASR result and prevents Agent admission', async t => {
  let transcript;
  const h = harness(t, { transcribe: () => transcript.promise });
  transcript = h.hold({ text: 'late text' });
  await h.activate(); h.audio(); await turn();
  const signal = h.calls.transcribes[0].signal;
  const before = h.calls.cancels;
  h.receive({ type: 'action', activationId: 'activation-a', name: 'cancel' });
  assert.equal(signal.aborted, true);
  assert.ok(h.calls.cancels > before);
  assert.equal(h.coordinator.status().active, null);
  const states = h.states().length;
  transcript.resolve({ text: 'late text' });
  await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 0);
  assert.equal(h.states().length, states);
});

test('closed and native process exit abort pending speech and stop subsequent admissions', async t => {
  for (const kind of ['closed', 'exit']) {
    let transcript;
    const h = harness(t, { transcribe: () => transcript.promise });
    transcript = h.hold({ text: 'late' });
    await h.activate(); h.audio(); await turn();
    if (kind === 'closed') h.receive({ type: 'closed', activationId: 'activation-a' }); else h.exit();
    assert.equal(h.calls.transcribes[0].signal.aborted, true);
    transcript.resolve({ text: 'late' });
    await h.coordinator.settled();
    assert.equal(h.calls.runs.length, 0);
    assert.equal(h.coordinator.status().active, null);
  }
});

test('a stale close/capture/action cannot affect the newer active generation', async t => {
  const h = harness(t);
  await h.activate('old'); await h.activate('new');
  const cancels = h.calls.cancels;
  h.receive({ type: 'closed', activationId: 'old' });
  h.receive({ type: 'capture', activationId: 'old', active: true });
  h.receive({ type: 'action', activationId: 'old', name: 'cancel' });
  assert.equal(h.coordinator.status().active.activationId, 'new');
  assert.equal(h.coordinator.status().microphoneActive, false);
  assert.equal(h.calls.cancels, cancels);
});

test('late rejection from a retired ASR cannot cancel a newer Agent task', async t => {
  let oldAsr, currentRun, calls = 0;
  const h = harness(t, { transcribe: () => ++calls === 1 ? oldAsr.promise : Promise.resolve({ text: 'new task' }), run: () => currentRun.promise });
  oldAsr = h.hold({ text: 'old' }); currentRun = h.hold({ status: 'done', say: 'new done' });
  await h.activate('old'); h.audio('old', 'old-utterance'); await turn();
  // activate() must not await the deliberately unresolved old task via settled().
  h.receive({ type: 'activated', activationId: 'new', capture: true, source: 'shortcut' });
  await turn(); h.audio('new', 'new-utterance'); await turn();
  assert.equal(h.calls.runs.length, 1);
  const before = h.calls.cancels;
  oldAsr.reject(new Error('late old ASR failure'));
  await turn();
  assert.equal(h.calls.cancels, before, 'stale catch must not cancel the new active session.run');
  assert.equal(h.coordinator.status().active.activationId, 'new');
  currentRun.resolve({ status: 'done', say: 'new done' });
  await h.coordinator.settled();
  assert.equal(h.states().at(-1).message, 'new done');
});

test('late completion from a retired Agent cannot cancel a newer Agent task', async t => {
  let oldRun, newRun, runs = 0;
  const h = harness(t, { run: () => ++runs === 1 ? oldRun.promise : newRun.promise });
  oldRun = h.hold({ status: 'done', say: 'old done' }); newRun = h.hold({ status: 'done', say: 'new done' });
  await h.activate('old'); h.audio('old', 'old-utterance'); await turn();
  h.receive({ type: 'activated', activationId: 'new', capture: true, source: 'shortcut' });
  await turn(); h.audio('new', 'new-utterance'); await turn();
  assert.equal(h.calls.runs.length, 2);
  const before = h.calls.cancels;
  oldRun.resolve({ status: 'done', say: 'old done' });
  await turn();
  assert.equal(h.calls.cancels, before, 'a stale aborted result cannot cancel the current task');
  assert.equal(h.coordinator.status().active.activationId, 'new');
  newRun.resolve({ status: 'done', say: 'new done' });
  await h.coordinator.settled();
  assert.equal(h.states().at(-1).message, 'new done');
});

test('timeout cancels an ASR that ignores AbortSignal without waiting for its eventual result', async t => {
  let transcript;
  const h = harness(t, { timeoutMs: 15, transcribe: () => transcript.promise });
  transcript = h.hold({ text: 'late after timeout' });
  await h.activate(); h.audio(); await turn();
  const before = h.calls.cancels;
  await delay(50);
  assert.equal(h.calls.transcribes[0].signal.aborted, true);
  assert.equal(h.coordinator.status().phase, 'error', 'deadline must publish failure before ignored ASR settles');
  assert.ok(h.calls.cancels > before);
  transcript.resolve({ text: 'late after timeout' });
  await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 0);
});

test('timeout cancels an Agent that ignores its signal and rejects any late delivery', async t => {
  let result;
  const h = harness(t, { timeoutMs: 15, run: () => result.promise });
  result = h.hold({ status: 'done', say: 'late delivery' });
  await h.activate(); h.audio(); await turn();
  const before = h.calls.cancels;
  await delay(50);
  assert.equal(h.calls.runs[0].signal.aborted, true);
  assert.equal(h.coordinator.status().phase, 'error');
  assert.ok(h.calls.cancels > before);
  const states = h.states().length;
  result.resolve({ status: 'done', say: 'late delivery' });
  await h.coordinator.settled();
  assert.equal(h.states().length, states);
  assert.ok(!h.states().some(state => state.message === 'late delivery'));
});

test('feature unload completes without awaiting a provider that ignores cancellation', async t => {
  let transcript;
  const h = harness(t, { transcribe: () => transcript.promise });
  transcript = h.hold({ text: 'late' });
  await h.activate(); h.audio(); await turn();
  let completed = false;
  const closing = h.coordinator.dispose().then(() => { completed = true; });
  await turn();
  assert.equal(completed, true, 'unload must detach the abandoned ASR Promise after cancellation');
  assert.equal(h.calls.transcribes[0].signal.aborted, true);
  assert.equal(h.coordinator.status().running, false);
  assert.equal(h.calls.runtimeDisposes, 1);
  transcript.resolve({ text: 'late' });
  await closing;
  assert.equal(h.calls.runs.length, 0);
});

for (const stage of ['documents', 'catalog']) {
  test(`unload does not await an uncooperative initial ${stage} readiness check`, async t => {
    let pending;
    const h = harness(t, stage === 'documents'
      ? { getDocumentStatus: () => pending.promise }
      : { getCatalog: () => pending.promise });
    pending = h.hold(stage === 'documents' ? { enabled: true, roots: ['fixture'] } : catalog());
    await h.coordinator.start();
    h.receive({ type: 'activated', activationId: 'activation-a', capture: true, source: 'shortcut' });
    await turn();
    assert.ok(h.states().every(state => state.listen !== true));
    let completed = false;
    const closing = h.coordinator.dispose().then(() => { completed = true; });
    await turn();
    assert.equal(completed, true, `${stage} provider cancellation cannot block plugin unload`);
    const states = h.states().length;
    pending.release();
    await closing;
    await turn();
    assert.equal(h.states().length, states);
    assert.equal(h.calls.runs.length, 0);
  });
}

test('the utterance deadline includes its document recheck and never starts ASR after that deadline', async t => {
  let permission, checks = 0;
  const h = harness(t, { timeoutMs: 15, getDocumentStatus: () => ++checks === 1
    ? { enabled: true, roots: ['fixture'] } : permission.promise });
  permission = h.hold({ enabled: true, roots: ['fixture'] });
  await h.activate(); h.audio(); await turn();
  await delay(50);
  assert.equal(h.coordinator.status().phase, 'error');
  assert.equal(h.calls.transcribes.length, 0);
  permission.release();
  await h.coordinator.settled();
  assert.equal(h.calls.transcribes.length, 0, 'late authorization must not invoke ASR with an already-aborted signal');
  assert.equal(h.calls.runs.length, 0);
});

test('cancel during an owned preparation requests its cancellation, but never cancels a preexisting preparation', async t => {
  const owned = harness(t, { catalog: catalog('unprepared') });
  await owned.activate(); owned.receive({ type: 'action', activationId: 'activation-a', name: 'prepare' }); await owned.coordinator.settled();
  owned.receive({ type: 'action', activationId: 'activation-a', name: 'cancel' }); await owned.coordinator.settled();
  assert.deepEqual(owned.calls.cancelPreparations, ['sensevoice-local']);
  const shared = harness(t, { catalog: catalog('downloading') });
  await shared.activate(); shared.receive({ type: 'action', activationId: 'activation-a', name: 'prepare' }); await shared.coordinator.settled();
  shared.receive({ type: 'action', activationId: 'activation-a', name: 'cancel' }); await shared.coordinator.settled();
  assert.deepEqual(shared.calls.cancelPreparations, []);
});

test('WAV validator enforces canonical encoding, full header, mono PCM16 and 16 kHz', () => {
  const encoded = wave(320000).toString('base64');
  assert.deepEqual(validateVoiceWave(encoded), { durationSeconds: 20, bytes: 640044 });
  for (const value of ['', encoded + '\n', Buffer.alloc(MAX_VOICE_AUDIO_BYTES + 1).toString('base64'), wave(320, 48000).toString('base64')]) {
    assert.throws(() => validateVoiceWave(value));
  }
  const badSize = wave(); badSize.writeUInt32LE(1, 4);
  const compressed = wave(); compressed.writeUInt16LE(3, 20);
  const badRate = wave(); badRate.writeUInt32LE(64000, 28);
  const noData = wave(0);
  for (const bytes of [badSize, compressed, badRate, noData]) assert.throws(() => validateVoiceWave(bytes.toString('base64')));
});

test('selected application history remains usable when file lookup is paused', async t => {
  const h = harness(t);
  h.setDocuments({ enabled: false, roots: ['fixture'], activityAllowed: true, activityRecording: false });
  await h.activate();
  assert.equal(h.states().at(-1).listen, true);
  h.text('我最近用了哪些应用'); await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 1);
  assert.equal(h.calls.runs[0].text, '我最近用了哪些应用');
});

test('selected application context remains usable with no file roots; activity false does not bypass old scope guard', async t => {
  const h = harness(t);
  h.setDocuments({ enabled: true, roots: [], activityAllowed: true, activityRecording: true });
  await h.activate();
  assert.equal(h.states().at(-1).listen, true);
  h.setDocuments({ enabled: false, roots: [], activityAllowed: false });
  h.audio(); await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 0);
  assert.equal(h.states().at(-1).phase, 'error');
});

test('capture callback completes before first reveal state and token only reaches Session options', async t => {
  const snapshot = deferred(), signals = [], releases = [];
  const h = harness(t, { captureCurrentContext: signal => { signals.push(signal); return snapshot.promise; }, releaseCurrentContext: token => releases.push(token) });
  await h.coordinator.start();
  h.receive({ type: 'activated', activationId: 'activation-a', capture: true, source: 'shortcut' });
  await turn();
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(h.states().length, 0, 'no state may reveal/focus the helper before the snapshot settles');
  h.setCatalog(catalog('ready')); await turn();
  assert.equal(h.states().length, 0, 'a background readiness update cannot bypass snapshot boundary');
  snapshot.resolve('private-context-token'); await h.coordinator.settled();
  assert.equal(h.states().at(-1).listen, true);
  assert.ok(!JSON.stringify(h.coordinator.status()).includes('private-context-token'));
  assert.ok(!JSON.stringify(h.sent).includes('private-context-token'));
  h.audio(); await h.coordinator.settled();
  assert.equal(h.calls.runs[0].contextToken, 'private-context-token');
  assert.equal(h.calls.runs[0].text, '打开预算文档', 'do not prepend hidden context to the user transcript');
  assert.deepEqual(releases, [], 'the successful real Session adapter owns release after handoff');
});

test('peek never captures current context, and failed optional capture cannot break ordinary voice', async t => {
  let captures = 0;
  const h = harness(t, { captureCurrentContext() { captures++; throw new Error('optional fixture failure'); } });
  await h.activate('peek', false, 'host');
  assert.equal(captures, 0);
  await h.activate('record', true);
  assert.equal(captures, 1);
  assert.equal(h.states().at(-1).listen, true);
  h.audio('record'); await h.coordinator.settled();
  assert.equal(h.calls.runs.length, 1);
  assert.equal(h.calls.runs[0].contextToken, undefined);
});

test('bounded optional capture ignores late success and releases its token without reopening or canceling voice', async t => {
  const snapshot = deferred(), releases = [];
  const h = harness(t, { contextCaptureMs: 5, captureCurrentContext: () => snapshot.promise, releaseCurrentContext: token => releases.push(token) });
  await h.activate();
  assert.equal(h.states().at(-1).listen, true);
  snapshot.resolve('late-private-token'); await turn(); await h.coordinator.settled();
  assert.deepEqual(releases, ['late-private-token']);
  h.audio(); await h.coordinator.settled();
  assert.equal(h.calls.runs[0].contextToken, undefined);
});

test('cancel while snapshot is pending emits no reveal and releases late token; prepared unused token releases too', async t => {
  const snapshot = deferred(), releases = [];
  const h = harness(t, { captureCurrentContext: () => snapshot.promise, releaseCurrentContext: token => releases.push(token) });
  await h.coordinator.start();
  h.receive({ type: 'activated', activationId: 'pending', capture: true, source: 'shortcut' });
  await turn(); h.coordinator.cancel(); await h.coordinator.settled();
  snapshot.resolve('retired-token'); await turn(); await h.coordinator.settled();
  assert.deepEqual(releases, ['retired-token']);
  assert.equal(h.states().length, 0);
  const readyReleases = [];
  const ready = harness(t, { captureCurrentContext: async () => 'ready-token', releaseCurrentContext: token => readyReleases.push(token) });
  await ready.activate(); ready.coordinator.cancel(); await ready.coordinator.settled();
  assert.deepEqual(readyReleases, ['ready-token']);
});

test('ASR failure or readiness disarming releases captured context that never reached Session', async t => {
  const releases = [];
  const h = harness(t, { captureCurrentContext: async () => 'failed-token', releaseCurrentContext: token => releases.push(token), transcribe: async () => { throw new Error('ASR fixture'); } });
  await h.activate(); h.audio(); await h.coordinator.settled();
  assert.deepEqual(releases, ['failed-token']); assert.equal(h.calls.runs.length, 0);
  const unprepared = harness(t, { catalog: catalog('unprepared'), captureCurrentContext: async () => 'unused-token', releaseCurrentContext: token => releases.push(token) });
  await unprepared.activate(); await turn();
  assert.ok(releases.includes('unused-token'));
});

test('Host record requests always use native toggle, including during an active turn', async t => {
  const h = harness(t, { run: async () => ({ status: 'clarify', say: '哪份资料？' }) });
  await h.activate(); const id = h.coordinator.status().active.activationId, cancels = h.calls.cancels;
  await h.coordinator.open({ capture: true }); await h.coordinator.open({ capture: true });
  assert.deepEqual(h.sent.slice(-2), [{ v: 1, type: 'toggle' }, { v: 1, type: 'toggle' }]);
  assert.equal(h.coordinator.status().active.activationId, id);
  assert.equal(h.calls.cancels, cancels);
});

test('shortcut precheck waits for correlated actual native ready and returns actual registration without mic', async t => {
  const h = harness(t);
  const configuring = h.coordinator.configureShortcut('Alt+Shift+Space');
  await turn();
  const message = h.sent.find(message => message.type === 'configure');
  assert.ok(message.configurationId);
  h.receive({ type: 'ready', shortcut: 'Alt+Shift+Space', registered: true, platform: 'darwin', electronVersion: 'fixture', configurationId: 'wrong-request' });
  let settled = false; void configuring.then(() => { settled = true; }); await turn();
  assert.equal(settled, false);
  h.receive({ type: 'ready', shortcut: 'Alt+Shift+Space', registered: true, platform: 'darwin', electronVersion: 'fixture', configurationId: message.configurationId });
  const result = await configuring;
  assert.equal(result.shortcut, 'Alt+Shift+Space'); assert.equal(result.registered, true);
  assert.equal(h.states().length, 0); assert.equal(h.calls.transcribes.length, 0); assert.equal(h.calls.runs.length, 0);
});

test('shortcut conflict reports native old registration and refuses fake success', async t => {
  const h = harness(t);
  const configuring = h.coordinator.configureShortcut('Alt+Shift+Space'); await turn();
  const message = h.sent.find(message => message.type === 'configure');
  h.receive({ type: 'notice', code: 'SHORTCUT_UNAVAILABLE', message: 'fixture occupied' });
  h.receive({ type: 'ready', shortcut: 'CommandOrControl+Shift+Space', registered: true, platform: 'darwin', electronVersion: 'fixture', configurationId: message.configurationId });
  await assert.rejects(configuring, /原有快捷键/u);
  assert.equal(h.coordinator.status().shortcut, 'CommandOrControl+Shift+Space');
});

test('shortcut changes are idle-only and reject unsafe accelerators without registering', async t => {
  const h = harness(t);
  for (const shortcut of ['Escape', 'a', 'Shift+A', 'Command+Q', 'Command+W', 'Command+Space', 'Control+C', 'Command+Shift+3', 'Alt+Tab']) {
    await assert.rejects(h.coordinator.configureShortcut(shortcut));
  }
  assert.equal(h.calls.starts.length, 0);
  await h.activate();
  await assert.rejects(h.coordinator.configureShortcut('Alt+Shift+Space'), /收起/u);
  assert.equal(h.sent.some(message => message.type === 'configure'), false);
});

test('shortcut ack waiting is bounded and cancellation/dispose revoke the waiter without recording', async t => {
  const timed = harness(t, { shortcutConfigureMs: 5 });
  await assert.rejects(timed.coordinator.configureShortcut('Alt+Shift+Space'), /超时/u);
  const h = harness(t), controller = new AbortController();
  const configuring = h.coordinator.configureShortcut('Alt+Shift+Space', { signal: controller.signal });
  await turn(); controller.abort();
  await assert.rejects(configuring, { name: 'AbortError' });
  const other = harness(t);
  const pending = other.coordinator.configureShortcut('Alt+Shift+Space');
  void pending.catch(() => {}); await turn(); await other.coordinator.dispose();
  await assert.rejects(pending);
  assert.equal(h.calls.runs.length + other.calls.runs.length, 0);
});
