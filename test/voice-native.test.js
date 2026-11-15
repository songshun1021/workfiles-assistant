import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHostMessage, parseHelperMessage, encodeMessage, createLineDecoder, MAX_LINE_BYTES, MAX_AUDIO_BYTES } from '../native/protocol.mjs';
import { createNativeController } from '../native/controller.mjs';
import { FEATURE_ORIGIN, FEATURE_URL, RESOURCE_TYPES, resourceForURL, isTrustedSender, allowAudioPermission, CONTENT_SECURITY_POLICY } from '../native/security.mjs';
import { buildEnvironment, isInside, APPROVED_CACHE_ROOT, resolveBuildOutputRoot, parseBuildArguments } from '../native/build-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = (type, fields = {}) => ({ v: 1, type, ...fields });
const wav = Buffer.from('RIFF-test-in-memory-only').toString('base64');
function fixture({ occupied = new Set() } = {}) {
  const events = [], states = [], shows = [], hides = [], unregistered = [], callbacks = new Map();
  let id = 0, controller;
  controller = createNativeController({
    send: event => events.push(event), onState: state => states.push(state), onShow: state => shows.push(state),
    onHide: state => { hides.push(state); controller.closed(state.activationId); },
    register: (accelerator, callback) => { if (occupied.has(accelerator)) return false; callbacks.set(accelerator, callback); return true; },
    unregister: accelerator => { unregistered.push(accelerator); callbacks.delete(accelerator); }, uuid: () => `native-${++id}`,
    platform: 'darwin', electronVersion: '44.7.0',
  });
  const init = () => controller.handleHost(host('init', { title: '工作资料', shortcut: 'CommandOrControl+Shift+Space' }));
  const show = (capture = false, activationId = `host-${++id}`) => { controller.handleHost(host('show', { activationId, capture })); return activationId; };
  const state = (phase, extra = {}) => controller.handleHost(host('state', { activationId: controller.snapshot().activationId, phase, ...extra }));
  return { controller, events, states, shows, hides, unregistered, callbacks, init, show, state };
}

// These tests do not import electron, create a window, register an OS shortcut,
// open a microphone, prompt for a permission, or start an Agent/server.
test('protocol exports bounded strict JS Host parsers and newline encoder', () => {
  assert.equal(MAX_LINE_BYTES, 3 * 1024 * 1024);
  const messages = [
    host('init', { shortcut: 'CommandOrControl+Shift+Space', title: '资料助手' }),
    host('show', { activationId: 'a-1', capture: false }),
    host('state', { activationId: 'a-1', phase: 'question', message: '找哪一份？', detail: '', listen: true, canPrepare: false, progress: 0.4 }),
    host('configure', { shortcut: 'Alt+Shift+Space' }), host('hide'), host('hide', { activationId: 'a-1' }), host('shutdown'),
  ];
  for (const message of messages) {
    const line = encodeMessage(message);
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.split('\n').length, 2);
    assert.deepEqual(parseHostMessage(line), message);
    assert.equal(Object.isFrozen(parseHostMessage(message)), true);
  }
});

test('helper message variants round-trip without leaking an arbitrary method', () => {
  const messages = [
    host('ready', { shortcut: 'Alt+Space', registered: false, platform: 'darwin', electronVersion: '44.7.0' }),
    host('activated', { activationId: 'a', source: 'panel', capture: true }),
    host('audio', { activationId: 'a', utteranceId: 'u', wavBase64: wav }),
    host('text', { activationId: 'a', utteranceId: 'u2', text: '找资料\n课题报告' }),
    host('action', { activationId: 'a', name: 'prepare' }), host('capture', { activationId: 'a', active: false }),
    host('notice', { code: 'OCCUPIED', message: '已占用' }), host('fatal', { code: 'BROKEN', message: '已停止' }), host('closed'), host('closed', { activationId: 'a' }),
  ];
  for (const message of messages) assert.deepEqual(parseHelperMessage(encodeMessage(message)), message);
  assert.throws(() => parseHelperMessage(host('open', { url: 'https://example.com' })));
});

test('unknown types, fields, versions, non-records and accessor inputs throw', () => {
  for (const value of [null, [], 1, 'not json', { v: 2, type: 'shutdown' }, host('shutdown', { extra: true }), host('unknown'), host('show', { activationId: 'a', capture: 1 }), host('show', { activationId: '../bad', capture: false })]) assert.throws(() => parseHostMessage(value));
  let getterCalled = false;
  const accessor = { get v() { getterCalled = true; return 1; }, type: 'shutdown' };
  assert.throws(() => parseHostMessage(accessor));
  assert.equal(getterCalled, false);
  assert.throws(() => parseHostMessage(Object.create({ v: 1, type: 'shutdown' })));
  assert.throws(() => parseHelperMessage(host('capture', { activationId: 'a', active: true, scope: 'global' })));
});

test('states enforce finite progress, text bounds and safe listening phases', () => {
  for (const progress of [-1, 1.1, NaN, Infinity, '0.1', undefined]) assert.throws(() => parseHostMessage(host('state', { activationId: 'a', phase: 'ready', progress })));
  for (const phase of ['ready', 'preparing', 'transcribing', 'working', 'done', 'error']) assert.throws(() => parseHostMessage(host('state', { activationId: 'a', phase, listen: true })));
  assert.throws(() => parseHostMessage(host('state', { activationId: 'a', phase: 'ready', message: '字'.repeat(1001) })));
  assert.throws(() => parseHelperMessage(host('text', { activationId: 'a', utteranceId: 'u', text: ' '.repeat(5) })));
  assert.throws(() => parseHelperMessage(host('text', { activationId: 'a', utteranceId: 'u', text: 'x'.repeat(2001) })));
});

test('UTF-8 bytes, not JS character count, bound the wire', () => {
  assert.throws(() => parseHostMessage('字'.repeat(MAX_LINE_BYTES / 3 + 1)), { code: 'LINE_TOO_LARGE' });
  assert.throws(() => parseHostMessage(new Uint8Array([0xff])), { code: 'INVALID_UTF8' });
});

test('audio validator enforces canonical bounded base64 and no extra fields', () => {
  const message = wavBase64 => host('audio', { activationId: 'a', utteranceId: 'u', wavBase64 });
  for (const value of ['', '???=', 'A===', 'a', 'YQ', 'YQ==\n', 'YR==']) assert.throws(() => parseHelperMessage(message(value)));
  const max = Buffer.alloc(MAX_AUDIO_BYTES).toString('base64');
  assert.equal(parseHelperMessage(message(max)).wavBase64.length, max.length);
  assert.throws(() => parseHelperMessage(message(Buffer.alloc(MAX_AUDIO_BYTES + 1).toString('base64'))));
});

test('incremental JSON Lines supports UTF-8 chunk boundaries and multiple records', () => {
  const messages = [host('init', { title: '语音资料助手', shortcut: 'Alt+Space' }), host('show', { activationId: 'a', capture: false }), host('shutdown')];
  const bytes = Buffer.from(messages.map(encodeMessage).join(''));
  const received = [], errors = [];
  const reader = createLineDecoder({ onMessage: m => received.push(m), onError: e => errors.push(e) });
  for (let start = 0; start < bytes.length; start += 7) reader.push(bytes.subarray(start, start + 7));
  reader.end();
  assert.deepEqual(received, messages); assert.deepEqual(errors, []);
});

test('framing terminates on overlong, malformed, blank or truncated lines', () => {
  for (const bytes of [Buffer.from('\n'), Buffer.from('{bad}\n'), Buffer.alloc(MAX_LINE_BYTES + 1, 32), Buffer.from([0xff, 10])]) {
    const errors = [], received = [];
    const reader = createLineDecoder({ onMessage: m => received.push(m), onError: e => errors.push(e) });
    reader.push(bytes); reader.push(Buffer.from(encodeMessage(host('shutdown')))); reader.end();
    assert.equal(errors.length, 1); assert.equal(received.length, 0);
  }
  const errors = [];
  const reader = createLineDecoder({ onMessage: () => assert.fail('partial line accepted'), onError: e => errors.push(e) });
  reader.push(Buffer.from('{"v":1')); reader.end();
  assert.equal(errors[0].code, 'TRUNCATED_LINE');
});

test('initialization registers only its owned key; it never shows or records', () => {
  const f = fixture(); f.init();
  assert.equal(f.events.at(-1).type, 'ready'); assert.equal(f.events.at(-1).registered, true);
  assert.equal(f.shows.length, 0); assert.equal(f.controller.mayCapture(), false);
  assert.equal(f.controller.snapshot().visible, false);
  f.controller.dispose(); f.controller.dispose();
  assert.deepEqual(f.unregistered, ['CommandOrControl+Shift+Space']);
});

test('occupied shortcut reports actual failure and transactional configure retains old', () => {
  const f = fixture({ occupied: new Set(['Alt+Space']) }); f.init();
  f.controller.handleHost(host('configure', { shortcut: 'Alt+Space' }));
  assert.equal(f.events.at(-1).shortcut, 'CommandOrControl+Shift+Space'); assert.equal(f.events.at(-1).registered, true);
  assert.equal(f.events.at(-2).code, 'SHORTCUT_UNAVAILABLE'); assert.deepEqual(f.unregistered, []);
  f.controller.handleHost(host('configure', { shortcut: 'Alt+Shift+Space' }));
  assert.equal(f.events.at(-1).shortcut, 'Alt+Shift+Space');
  assert.deepEqual(f.unregistered, ['CommandOrControl+Shift+Space']);
  f.controller.dispose(); assert.deepEqual(f.unregistered, ['CommandOrControl+Shift+Space', 'Alt+Shift+Space']);
  const blocked = fixture({ occupied: new Set(['CommandOrControl+Shift+Space']) }); blocked.init();
  assert.equal(blocked.events.at(-1).registered, false); blocked.controller.dispose(); assert.deepEqual(blocked.unregistered, []);
});

test('Host peek plus a listen state cannot arm capture', () => {
  const f = fixture(); f.init(); const id = f.show(false);
  f.state('listening', { listen: true });
  assert.equal(f.controller.mayCapture(), false); assert.equal(f.controller.snapshot().capture, false);
  assert.throws(() => f.controller.renderer('capture', { activationId: id, active: true }), { code: 'CAPTURE_NOT_ARMED' });
  assert.throws(() => f.controller.renderer('audio', { activationId: id, utteranceId: 'u', wavBase64: wav }), { code: 'AUDIO_NOT_ARMED' });
});

test('explicit retry is a fresh panel activation and does not double-forward retry', () => {
  const f = fixture(); f.init(); const old = f.show(false);
  f.controller.renderer('action', { activationId: old, name: 'retry' });
  const event = f.events.findLast(event => event.type === 'activated');
  assert.equal(event.source, 'panel'); assert.equal(event.capture, true); assert.notEqual(event.activationId, old);
  assert.equal(f.events.some(event => event.type === 'action' && event.name === 'retry'), false);
  assert.equal(f.controller.snapshot().listen, false); assert.equal(f.controller.mayCapture(), false);
  f.state('listening', { listen: true }); assert.equal(f.controller.mayCapture(), true);
});

test('stale states, hide and renderer generations cannot affect a newer activation', () => {
  const f = fixture(); f.init(); const old = f.show(true); f.state('done'); f.controller.shortcut(); const latest = f.controller.snapshot().activationId;
  const snapshot = f.controller.snapshot();
  for (const message of [host('hide', { activationId: old }), host('state', { activationId: old, phase: 'listening', listen: true }), host('show', { activationId: old, capture: true })]) assert.throws(() => f.controller.handleHost(message), { code: 'STALE_ACTIVATION' });
  assert.throws(() => f.controller.renderer('capture', { activationId: old, active: true }), { code: 'STALE_ACTIVATION' });
  f.controller.closed(old);
  assert.deepEqual(f.controller.snapshot(), snapshot); assert.equal(snapshot.activationId, latest);
});

test('second shortcut while permission is pending signals stop-submit and permits one final audio', () => {
  const f = fixture(); f.init(); f.controller.shortcut(); const id = f.controller.snapshot().activationId;
  f.state('listening', { listen: true }); f.controller.shortcut();
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.signal, 'stop-submit'); assert.equal(snapshot.signalId, 1);
  assert.equal(snapshot.capture, false); assert.equal(snapshot.listen, false); assert.equal(snapshot.phase, 'listening');
  assert.equal(f.controller.mayCapture(), false);
  f.controller.renderer('audio', { activationId: id, utteranceId: 'u1', wavBase64: wav });
  assert.equal(f.events.at(-1).type, 'audio');
  assert.throws(() => f.controller.renderer('audio', { activationId: id, utteranceId: 'u2', wavBase64: wav }), { code: 'AUDIO_NOT_ARMED' });
  f.state('question', { listen: true });
  assert.equal(f.controller.mayCapture(), false, 'even an old listen:true question cannot rearm');
  assert.throws(() => f.controller.renderer('audio', { activationId: id, utteranceId: 'u1', wavBase64: wav }), { code: 'AUDIO_NOT_ARMED' });
  f.controller.shortcut();
  const answer = f.controller.snapshot().activationId;
  assert.notEqual(answer, id);
  f.state('listening', { listen: true });
  f.controller.renderer('audio', { activationId: answer, utteranceId: 'u2', wavBase64: wav });
});

test('capture reports facts; terminal Host state cannot leave a submission gate open', () => {
  const f = fixture(); f.init(); const id = f.show(true); f.state('listening', { listen: true });
  f.controller.renderer('capture', { activationId: id, active: true });
  assert.equal(f.controller.isCapturing(), true); assert.equal(f.events.at(-1).active, true);
  f.state('error', { message: '已停止' });
  assert.equal(f.controller.mayCapture(), false);
  assert.throws(() => f.controller.renderer('audio', { activationId: id, utteranceId: 'late', wavBase64: wav }), { code: 'AUDIO_NOT_ARMED' });
  f.controller.renderer('capture', { activationId: id, active: false });
  assert.equal(f.controller.isCapturing(), false); assert.equal(f.events.at(-1).active, false);
});

test('shortcut while busy only shows current status; only explicit cancel retires the task', () => {
  for (const phase of ['preparing', 'transcribing', 'working']) {
    const f = fixture(); f.init(); const id = f.show(true); f.state(phase);
    const events = f.events.length;
    f.controller.shortcut();
    assert.equal(f.events.length, events);
    assert.equal(f.controller.snapshot().activationId, id);
    assert.equal(f.controller.snapshot().visible, true);
    assert.equal(f.controller.mayCapture(), false);
    f.controller.handleHost(host('toggle'));
    assert.equal(f.controller.snapshot().activationId, id);
    assert.equal(f.events.length, events);
    f.controller.renderer('action', { activationId: id, name: 'cancel' });
    assert.equal(f.events.some(event => event.type === 'action' && event.name === 'cancel'), true);
    assert.equal(f.controller.snapshot().visible, false);
  }
});

test('preparation explicitly disarms; readiness/download completion cannot reopen mic', () => {
  const f = fixture(); f.init(); const id = f.show(true);
  f.state('ready', { canPrepare: true });
  f.controller.renderer('action', { activationId: id, name: 'prepare' });
  assert.equal(f.events.at(-1).name, 'prepare');
  f.state('preparing', { progress: 0.5 }); f.state('ready'); f.state('listening', { listen: true });
  assert.equal(f.controller.mayCapture(), false); assert.equal(f.controller.snapshot().capture, false);
  assert.throws(() => f.controller.handleHost(host('show', { activationId: id, capture: true })), { code: 'ACTIVATION_REARM' });
  f.controller.renderer('action', { activationId: id, name: 'retry' }); f.state('listening', { listen: true });
  assert.equal(f.controller.mayCapture(), true);
});

test('cancel/parent shutdown revoke late work, close renderer and release only owned accelerator', () => {
  const f = fixture(); f.init(); const id = f.show(true); f.state('listening', { listen: true });
  f.controller.renderer('capture', { activationId: id, active: true });
  f.controller.renderer('action', { activationId: id, name: 'cancel' });
  assert.equal(f.controller.isCapturing(), false); assert.equal(f.controller.snapshot().visible, false);
  assert.equal(f.events.findLast(event => event.type === 'capture').active, false);
  assert.throws(() => f.controller.renderer('audio', { activationId: id, utteranceId: 'late', wavBase64: wav }), { code: 'STALE_ACTIVATION' });
  f.controller.handleHost(host('shutdown')); assert.equal(f.callbacks.size, 0);
  assert.throws(() => f.controller.handleHost(host('show', { activationId: 'after', capture: true })), { code: 'DISPOSED' });
});

test('typed fallback is explicit user text even in peek and never arms a microphone', () => {
  const f = fixture(); f.init(); const id = f.show(false);
  f.controller.renderer('text', { activationId: id, utteranceId: 'typed1', text: '打开最新课题报告' });
  assert.equal(f.events.at(-1).type, 'text'); assert.equal(f.controller.mayCapture(), false);
  assert.throws(() => f.controller.renderer('action', { activationId: id, name: 'retry' }), { code: 'BUSY' });
  assert.throws(() => f.controller.renderer('text', { activationId: id, utteranceId: 'typed2', text: '不得并行' }), { code: 'BUSY' });
});

test('renderer methods reject transport fields and unknown payload fields', () => {
  const f = fixture(); f.init(); const id = f.show(false);
  for (const payload of [{ activationId: id, active: false, v: 1 }, { activationId: id, active: false, type: 'capture' }, { activationId: id, active: false, path: '/tmp' }, null, []]) assert.throws(() => f.controller.renderer('capture', payload));
  assert.throws(() => f.controller.renderer('shell', { activationId: id }));
});

function mediaFixture() {
  const frame = { url: FEATURE_URL, parent: null };
  const webContents = { mainFrame: frame, getURL: () => FEATURE_URL, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false, isVisible: () => true };
  const controller = { mayCapture: () => true };
  return { frame, webContents, window, controller, kind: 'check', permission: 'media', origin: FEATURE_ORIGIN, details: { isMainFrame: true, requestingUrl: FEATURE_URL, mediaType: 'audio' } };
}
test('sender trust requires exact owned WebContents, main frame and feature URL', () => {
  const f = mediaFixture();
  assert.equal(isTrustedSender({ sender: f.webContents, senderFrame: f.frame }, f.webContents), true);
  for (const event of [{ sender: { ...f.webContents }, senderFrame: f.frame }, { sender: f.webContents, senderFrame: { ...f.frame } }, { sender: f.webContents, senderFrame: null }]) assert.equal(isTrustedSender(event, f.webContents), false);
  f.frame.parent = {}; assert.equal(isTrustedSender({ sender: f.webContents, senderFrame: f.frame }, f.webContents), false);
  f.frame.parent = null; f.frame.url = `${FEATURE_URL}?injected`; assert.equal(isTrustedSender({ sender: f.webContents, senderFrame: f.frame }, f.webContents), false);
});

test('audio permission requires visible armed listening and exact current audio-only feature frame', () => {
  const f = mediaFixture(); assert.equal(allowAudioPermission(f), true);
  const request = { ...f, kind: 'request', details: { ...f.details, mediaTypes: ['audio'] } };
  assert.equal(allowAudioPermission(request), true);
  for (const change of [
    { permission: 'display-capture' }, { permission: 'camera' }, { permission: 'geolocation' }, { permission: 'mediaKeySystem' },
    { origin: 'https://example.com' }, { origin: `${FEATURE_ORIGIN}.evil` }, { origin: 'null' },
    { controller: { mayCapture: () => false } }, { webContents: null }, { window: { ...f.window, isVisible: () => false } },
    { details: { ...f.details, isMainFrame: false } }, { details: { ...f.details, mediaType: 'video' } },
    { details: { ...f.details, mediaType: 'unknown' } }, { details: { ...f.details, requestingUrl: `${FEATURE_URL}#bad` } },
  ]) assert.equal(allowAudioPermission({ ...f, ...change }), false);
  for (const mediaTypes of [[], ['video'], ['audio', 'video'], undefined]) assert.equal(allowAudioPermission({ ...request, details: { ...request.details, mediaTypes } }), false);
});

test('local feature resource allowlist has no traversal, remote URLs, file URLs or generic fetch', () => {
  const allowed = ['index.html', 'panel.js', 'panel.css', 'audio.js', 'view-state.js', 'icon.svg'];
  assert.deepEqual(Object.keys(RESOURCE_TYPES).sort(), [...allowed].sort());
  for (const name of allowed) assert.equal(resourceForURL(`${FEATURE_ORIGIN}/${name}`), name);
  assert.equal(RESOURCE_TYPES['view-state.js'], 'text/javascript; charset=utf-8');
  for (const suffix of ['.map', '?q=1', '#fragment', '/extra']) assert.equal(resourceForURL(`${FEATURE_ORIGIN}/view-state.js${suffix}`), null);
  for (const url of ['file:///etc/passwd', 'https://example.com', `${FEATURE_ORIGIN}/../index.html`, `${FEATURE_ORIGIN}/%2e%2e/index.html`, `${FEATURE_ORIGIN}/native/main.mjs`, `${FEATURE_URL}?q=1`, `${FEATURE_URL}#x`, 'workfiles-voice://panel.evil/index.html', 'workfiles-voice://user@panel/index.html', 'workfiles-voice://panel:80/index.html', `${FEATURE_ORIGIN}/`]) assert.equal(resourceForURL(url), null);
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'"]) assert.equal(CONTENT_SECURITY_POLICY.includes(directive), true);
  assert.equal(CONTENT_SECURITY_POLICY.includes('unsafe-'), false);
});

test('sandbox preload exposes a fixed, small method set and strips Electron event objects', async () => {
  let exposed, listener; const calls = [], removed = [];
  const source = await fs.readFile(path.join(root, 'native/preload.cjs'), 'utf8');
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'workfilesVoice'); exposed = api; } },
      ipcRenderer: { invoke: (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve(); }, on: (channel, fn) => { assert.equal(channel, 'workfiles-voice:state'); listener = fn; }, removeListener: (channel, fn) => removed.push([channel, fn]) } };
  } });
  assert.deepEqual(Object.keys(exposed).sort(), ['action', 'audio', 'capture', 'clipboard', 'onState', 'ready', 'select', 'text'].sort());
  const values = []; const dispose = exposed.onState((...args) => values.push(args));
  const value = { activationId: 'a', capture: false }; listener({ secretElectronEvent: true }, value);
  assert.deepEqual(values, [[value]]); dispose(); dispose(); assert.equal(removed.length, 1);
  await exposed.ready();
  for (const method of ['audio', 'text', 'action', 'capture', 'clipboard', 'select']) await exposed[method]({ activationId: 'a' });
  assert.deepEqual(calls.map(call => call[0]), ['ready', 'audio', 'text', 'action', 'capture', 'clipboard', 'select'].map(method => `workfiles-voice:${method}`));
  assert.throws(() => exposed.onState(null));
});

test('main source retains strict sandbox, lazy real page, no proactive mic/AX/display access', async () => {
  const source = await fs.readFile(path.join(root, 'native/main.mjs'), 'utf8');
  for (const required of ['app.enableSandbox()', 'contextIsolation: true', 'sandbox: true', 'nodeIntegration: false', 'webSecurity: true', "autoplayPolicy: 'no-user-gesture-required'", 'isTrustedSender(event, window.webContents)', "process.stdin.on('end', () => shutdown())", "process.stdin.on('close', () => shutdown())", 'ownedWindow.loadURL(FEATURE_URL)', "callback({})"]) assert.equal(source.includes(required), true, required);
  for (const forbidden of ['unregisterAll(', 'askForMediaAccess(', 'isTrustedAccessibilityClient(', 'desktopCapturer', 'executeJavaScript(', 'http://', 'https://', 'shell.open', 'createServer(']) assert.equal(source.includes(forbidden), false, forbidden);
});

test('the panel window is transparent, so the native material is what the user sees', async () => {
  const source = await fs.readFile(path.join(root, 'native/main.mjs'), 'utf8');
  // `backgroundColor` alpha is ignored without `transparent`; the window then paints its
  // default #FFF under the page and the vibrancy is never visible. This exact pair is the
  // difference between a frosted card and a white rectangle, so it is asserted, not assumed.
  assert.match(source, /transparent: true/);
  assert.match(source, /backgroundColor: '#00000000'/);
  const material = source.match(/vibrancy: '([a-z-]+)'/);
  assert.ok(material, 'a vibrancy material must be chosen');
  // Every one of these stays light in light appearance. The background-reflective
  // `appearance-based`/`light` materials look closer to the design over a pale wallpaper,
  // but over a dark window they drop to a dark card while the page still draws dark text,
  // because the panel follows the system appearance rather than the wallpaper.
  assert.ok(['content', 'sidebar', 'under-window', 'header', 'sheet', 'window'].includes(material[1]), material[1]);
});

test('one frame carries the session from listening to conversation', async () => {
  const source = await fs.readFile(path.join(root, 'native/main.mjs'), 'utf8');
  // Content length is the page's problem (it scrolls and reports the clipped edge); the
  // window must not resize under the reader as turns arrive, and the listening stage must
  // not be a different, smaller surface that the card later grows out of.
  assert.match(source, /const PANEL_VOICE = Object\.freeze\(\{ width: 620, height: 268 \}\)/u);
  assert.match(source, /function applySize\(\)/u);
  assert.doesNotMatch(source, /PANEL_(?:COMPACT|FULL|TALL|THREAD)|conversationSize/u);
});

test('builder output root is only the project native directory or exact user-approved cache', () => {
  assert.equal(APPROVED_CACHE_ROOT, path.join(os.homedir(), 'Library/Caches/DeepSeekHarness/WorkfilesVoice'));
  assert.equal(resolveBuildOutputRoot(root), path.join(root, '.native'));
  assert.equal(resolveBuildOutputRoot(root, '.native'), path.join(root, '.native'));
  assert.equal(resolveBuildOutputRoot(root, APPROVED_CACHE_ROOT), APPROVED_CACHE_ROOT);
  for (const value of ['/tmp', '/Users/sean/Library/Caches', path.dirname(APPROVED_CACHE_ROOT), `${APPROVED_CACHE_ROOT}-evil`, `${APPROVED_CACHE_ROOT}/extra`, path.join(root, '.native-evil'), '', null, 1]) assert.throws(() => resolveBuildOutputRoot(root, value));
});

test('builder CLI accepts both scoped options in either order and rejects unknown/duplicate/missing flags', () => {
  assert.deepEqual(parseBuildArguments([]), {});
  assert.deepEqual(parseBuildArguments(['--output-root', APPROVED_CACHE_ROOT]), { outputRoot: APPROVED_CACHE_ROOT });
  assert.deepEqual(parseBuildArguments(['--source-executable', '/installed/runtime', '--output-root', APPROVED_CACHE_ROOT]), { sourceExecutable: '/installed/runtime', outputRoot: APPROVED_CACHE_ROOT });
  assert.deepEqual(parseBuildArguments(['--output-root', APPROVED_CACHE_ROOT, '--source-executable', '/installed/runtime']), { sourceExecutable: '/installed/runtime', outputRoot: APPROVED_CACHE_ROOT });
  for (const args of [['--output-root'], ['--output-root', '--source-executable'], ['--output-root', APPROVED_CACHE_ROOT, '--output-root', APPROVED_CACHE_ROOT], ['--deep', 'true'], ['--source-executable', ''], ['extra']]) assert.throws(() => parseBuildArguments(args));
});

test('builder uses env allowlist, versioned owned output and never deep-signs external frameworks', async () => {
  const env = buildEnvironment({ HOME: '/home/user', TMPDIR: '/tmp', LANG: 'zh_CN.UTF-8', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=evil', DYLD_INSERT_LIBRARIES: '/bad', SECRET: 'token', DSH_API_KEY: 'secret' });
  assert.deepEqual(env, { HOME: '/home/user', TMPDIR: '/tmp', LANG: 'zh_CN.UTF-8', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.equal(isInside('/owned/.native', '/owned/.native/hash/app'), true);
  assert.equal(isInside('/owned/.native', '/owned/.native-evil/app'), false);
  assert.equal(isInside('/owned/.native', '/owned/.native/../other'), false);
  const source = await fs.readFile(path.join(root, 'native/build-helper.mjs'), 'utf8');
  assert.equal(source.includes("['--force', '--sign', '-', '--options', 'runtime'"), true);
  assert.equal(source.includes("'--deep'"), false);
  assert.equal(/fs\.(rm|rmdir|unlink|rename)\(/u.test(source), false);
  assert.equal(source.includes("['com.apple.ResourceFork', 'com.apple.FinderInfo']"), true);
  assert.equal(source.includes('original fuses will not be changed'), true);
});

test('initial recording reveal is inactive until first Host state; subsequent state updates never steal focus', () => {
  const f = fixture(); f.init(); f.controller.shortcut();
  const id = f.controller.snapshot().activationId;
  assert.deepEqual(f.shows.at(-1), { activationId: id, title: '工作资料', focus: false });
  const events = f.events.length;
  f.controller.shortcut();
  assert.equal(f.events.length, events);
  assert.equal(f.shows.at(-1).focus, false, 'busy while Host snapshots must retain original foreground focus');
  f.state('preparing');
  assert.equal(f.shows.at(-1).focus, true);
  const shows = f.shows.length;
  f.state('listening', { listen: true }); f.state('working');
  assert.equal(f.shows.length, shows, 'ordinary state/progress updates do not refocus');
  f.controller.shortcut();
  assert.equal(f.shows.length, shows + 1, 'explicit busy shortcut may show status');
  assert.equal(f.controller.snapshot().activationId, id);
});

test('strict Host toggle uses same native state machine and does not rearm a busy preview', () => {
  assert.deepEqual(parseHostMessage(host('toggle')), host('toggle'));
  assert.throws(() => parseHostMessage(host('toggle', { capture: true })), { code: 'INVALID_MESSAGE' });
  const f = fixture(); f.init(); f.controller.handleHost(host('toggle'));
  const activated = f.events.findLast(event => event.type === 'activated');
  assert.equal(activated.source, 'host'); assert.equal(activated.capture, true);
  const id = activated.activationId, count = f.events.length;
  f.controller.handleHost(host('show', { activationId: 'fresh-preview', capture: false }));
  assert.equal(f.controller.snapshot().activationId, id);
  assert.equal(f.events.length, count);
  assert.equal(f.shows.at(-1).focus, false);
});

test('configure ack echoes correlation while conflicts retain real old registration and busy rejects mutation', () => {
  const f = fixture({ occupied: new Set(['Alt+Shift+Space']) }); f.init();
  f.controller.handleHost(host('configure', { shortcut: 'Alt+Shift+Space', configurationId: 'configuration-conflict' }));
  assert.equal(f.events.at(-1).configurationId, 'configuration-conflict');
  assert.equal(f.events.at(-1).shortcut, 'CommandOrControl+Shift+Space');
  f.controller.handleHost(host('configure', { shortcut: 'Control+Alt+Space', configurationId: 'configuration-ok' }));
  assert.equal(f.events.at(-1).configurationId, 'configuration-ok');
  assert.equal(f.events.at(-1).shortcut, 'Control+Alt+Space');
  assert.equal(f.events.at(-1).registered, true);
  f.show(false);
  f.controller.handleHost(host('configure', { shortcut: 'Alt+Space', configurationId: 'configuration-busy' }));
  assert.equal(f.events.at(-1).shortcut, 'Control+Alt+Space');
  assert.equal(f.events.at(-1).configurationId, 'configuration-busy');
  assert.ok(f.events.some(event => event.type === 'notice' && event.code === 'SHORTCUT_BUSY'));
});

test('global shortcut protocol rejects bare typing, Escape, and reserved operations', () => {
  for (const shortcut of ['Escape', 'Command+Escape', 'a', 'Shift+A', 'Command+Q', 'Control+C', 'Command+Space', 'Alt+Tab', 'Command+Shift+3', 'Control+Control+Space']) {
    assert.throws(() => parseHostMessage(host('configure', { shortcut })), { code: 'UNSAFE_SHORTCUT' });
  }
  for (const shortcut of ['Alt+Space', 'Control+Alt+Space', 'CommandOrControl+Shift+Space', 'Control+Alt+K']) {
    assert.equal(parseHostMessage(host('configure', { shortcut })).shortcut, shortcut);
  }
});

test('native main uses showInactive for pre-snapshot UI and limits Esc to its focused panel', async () => {
  const source = await fs.readFile(path.join(root, 'native/main.mjs'), 'utf8');
  assert.ok(source.includes('else ownedWindow.showInactive()'));
  assert.ok(source.includes('ownedWindow.isFocused() && input.type'));
  assert.ok(source.includes('state.activationId !== activationId'));
  assert.ok(!source.includes('previousApplication.activate'));
});

test('readonly peek preserves every visible activation including active microphone and completed feedback', () => {
  for (const phase of ['ready', 'preparing', 'listening', 'transcribing', 'working', 'question', 'done', 'error']) {
    const f = fixture(); f.init(); const id = f.show(true);
    f.state(phase, phase === 'listening' ? { listen: true } : {});
    if (phase === 'listening') f.controller.renderer('capture', { activationId: id, active: true });
    const before = f.controller.snapshot(), count = f.events.filter(event => event.type === 'activated').length;
    f.show(false);
    assert.deepEqual(f.controller.snapshot(), before, phase);
    assert.equal(f.events.filter(event => event.type === 'activated').length, count, phase);
    assert.equal(f.controller.mayCapture(), phase === 'listening', phase);
  }
});

test('presentation rows may carry a type chip and a copy string, and nothing else', async () => {
  const { parseHostMessage } = await import('../native/protocol.mjs');
  const base = { v: 1, type: 'state', activationId: 'activation-a', phase: 'done' };
  const accepted = parseHostMessage({ ...base, items: [{ name: 'e-bot-panel', type: 'HTML', copy: '/Users/s/稿子.html', copyKind: 'path' }, { name: 'X 上的某条推文', type: 'LINK', copy: 'https://x.com/a/1', copyKind: 'link' }] });
  assert.equal(accepted.items.length, 2);
  assert.equal(accepted.items[0].type, 'HTML');
  // Display data only: no ids, no paths beyond the copy string, bounded count and size.
  for (const items of [
    [{ name: '' }],
    [{ name: 'x', id: 'wf-1' }],
    [{ name: 'x', copyKind: 'open' }],
    [{ name: 'x', copy: 1 }],
    [{ name: 'x'.repeat(301) }],
    [{ name: 'x', type: 'HTMLHTMLHTML' }],
    Array.from({ length: 6 }, () => ({ name: 'x' })),
  ]) assert.throws(() => parseHostMessage({ ...base, items }), undefined, JSON.stringify(items).slice(0, 80));
});

test('a transcript is bounded on the wire: roles, text, rows, and no unknown fields', async () => {
  const { parseHostMessage } = await import('../native/protocol.mjs');
  const base = { v: 1, type: 'state', activationId: 'activation-a', phase: 'done' };
  const rows = [{ name: '稿子', type: 'HTML', copy: '/a/稿子.html', copyKind: 'path' }];
  const accepted = parseHostMessage({ ...base, turns: [{ role: 'user', text: '帮我找环润讯的推文' }, { role: 'assistant', text: '找到 2 条', items: rows }] });
  assert.equal(accepted.turns.length, 2);
  assert.equal(accepted.turns[1].items[0].type, 'HTML');
  for (const turns of [
    [{ role: 'system', text: 'x' }],
    [{ role: 'user', text: '' }],
    [{ role: 'user', text: 'x'.repeat(601) }],
    [{ role: 'user', text: 'x', extra: 1 }],
    [{ role: 'assistant', text: 'x', items: Array.from({ length: 6 }, () => ({ name: 'y' })) }],
    Array.from({ length: 9 }, () => ({ role: 'user', text: 'x' })),
    'not-an-array',
  ]) assert.throws(() => parseHostMessage({ ...base, turns }), undefined, JSON.stringify(turns).slice(0, 60));
});

test('a settled panel continues in the same window instead of closing and reopening', () => {
  const f = fixture(); f.init(); f.controller.shortcut();
  const first = f.controller.snapshot().activationId;
  f.state('done', { message: '找到 2 条' });
  const hides = f.hides.length;
  f.controller.shortcut();
  // The old activation is retired quietly (reason "continue") and no window teardown is asked for.
  assert.equal(f.hides.length, hides + 1);
  assert.equal(f.hides.at(-1).reason, 'continue');
  assert.equal(f.hides.at(-1).activationId, first);
  assert.notEqual(f.controller.snapshot().activationId, first);
  assert.equal(f.controller.snapshot().visible, true);
  // While the microphone is open a shortcut still means stop-and-submit, not a new turn.
  f.state('listening', { listen: true });
  const armed = f.controller.snapshot().activationId;
  f.controller.shortcut();
  assert.equal(f.controller.snapshot().activationId, armed);
  assert.equal(f.controller.snapshot().signal, 'stop-submit');
});

test('a row click is forwarded as an index bound to the current activation', async () => {
  const { parseHelperMessage, parseHostMessage } = await import('../native/protocol.mjs');
  const select = parseHelperMessage({ v: 1, type: 'select', activationId: 'activation-a', index: 2 });
  assert.equal(select.index, 2);
  for (const message of [
    { v: 1, type: 'select', activationId: 'activation-a', index: -1 },
    { v: 1, type: 'select', activationId: 'activation-a', index: 5 },
    { v: 1, type: 'select', activationId: 'activation-a', index: 1.5 },
    { v: 1, type: 'select', activationId: 'activation-a', index: '1' },
    { v: 1, type: 'select', activationId: 'activation-a', index: 1, path: '/a' },
  ]) assert.throws(() => parseHelperMessage(message), undefined, JSON.stringify(message));
  // The Host-side state that carries the rows has no id field for the renderer to use.
  const state = parseHostMessage({ v: 1, type: 'state', activationId: 'activation-a', phase: 'done', items: [{ name: 'a', type: 'PPT' }] });
  assert.equal(Object.hasOwn(state.items[0], 'id'), false);
});
