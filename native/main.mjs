import { app, BrowserWindow, globalShortcut, ipcMain, Menu, protocol, screen, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import { createLineDecoder, encodeMessage, ProtocolError } from './protocol.mjs';
import { createNativeController } from './controller.mjs';
import { absorbOpacity, absorbTarget, clamp01, easeLeave, easeMorph, FRAME_MS, lerpBounds, LEAVE_MS, morphTarget, MORPH_MS } from './motion.mjs';
import { FEATURE_SCHEME, FEATURE_URL, RESOURCE_TYPES, CONTENT_SECURITY_POLICY, resourceForURL, isTrustedSender, allowAudioPermission } from './security.mjs';

// stdout is exclusively bounded JSON Lines, including fatal diagnostics.
for (const key of ['log', 'info', 'warn', 'error', 'debug']) console[key] = (...args) => process.stderr.write(`${format(...args).slice(0, 2000)}\n`);
const localDir = path.dirname(fileURLToPath(import.meta.url));
const prefix = 'workfiles-voice:';
let window = null, loading = null, featureSession = null, controller = null, revealTarget = null;
let exiting = false, initialized = false, queued = [], stopTimer = null;
let initTimer = setTimeout(() => fatal('INIT_TIMEOUT', 'Native helper did not receive init.'), 15000);

protocol.registerSchemesAsPrivileged([{ scheme: FEATURE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false, allowServiceWorkers: false } }]);
app.setName('Workfiles Voice Helper');
// Never share the Harness browser profile, cookies, auth, or session storage.
// Non-persistent partition below owns the renderer; these paths are the helper's
// own runtime cache/log area inside the explicitly owned build directory.
const runtimeDir = path.resolve(localDir, '../../../../..', 'runtime');
app.setPath('userData', runtimeDir);
app.setPath('sessionData', path.join(runtimeDir, 'chromium'));
app.setAppLogsPath(path.join(runtimeDir, 'logs'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('no-default-browser-check');
app.enableSandbox();

function send(message) {
  if (process.stdout.destroyed) return;
  const line = encodeMessage(message);
  if (process.stdout.writableLength > 4 * 1024 * 1024) { shutdown(1); return; }
  process.stdout.write(line);
}
function notice(code, message) { send({ v: 1, type: 'notice', code, message }); }
// While a task is actually running, shrink the owned window so the user watches the
// task, not the form. Background agents keep the full panel for questions/results.
const PANEL_FULL = Object.freeze({ width: 620, height: 200 });
const PANEL_COMPACT = Object.freeze({ width: 460, height: 124 });
const COMPACT_PHASES = new Set(['preparing', 'listening', 'transcribing', 'working']);

/* --------------------------------------------------------------- motion ----
 * The card *is* the window: the page paints only a tint over the native material, so a
 * size change is a real frame change. One wall-clock clock drives geometry and opacity
 * from the same eased progress, which means they cannot disagree, a late frame skips
 * ahead instead of stretching the motion, and an interrupted animation retargets from
 * the live frame instead of snapping. motion.mjs owns the curve and the anchoring;
 * this file owns the clock and the frame writes.
 */
let motion = null, motionBase = null;
function stopMotion() {
  if (motion) clearTimeout(motion.timer);
  motion = null;
  motionBase = null;
}
// Exit is cancellable: a replacement activation re-uses the same window mid-animation and
// must never be destroyed underneath it, so the frame it had before the animation and full
// opacity are put back before that window is shown again. The baseline survives a motion
// that was stopped by a guard, which is exactly the case a re-show races with.
function cancelMotion() {
  const base = motionBase;
  stopMotion();
  if (!base || !window || window.isDestroyed()) return;
  try { window.setOpacity(1); } catch { /* a closing window needs no restore */ }
  try { window.setBounds(base, false); } catch { /* a closing window needs no restore */ }
}
function animateWindow({ to, duration, ease, size = null, opacity = null, guard = null, done = null }) {
  const target = window;
  if (exiting || !target || target.isDestroyed() || !to) return;
  let from;
  try { from = target.getBounds(); } catch { return; }
  // A retarget keeps the frame the chain started from, so a cancelled animation still has
  // somewhere truthful to return to.
  if (!motionBase) motionBase = from;
  stopMotion();
  const token = { size, timer: null };
  motion = token;
  const started = performance.now();
  let painted = null;
  const step = () => {
    // A newer motion, a re-shown window or a closing helper all supersede this one.
    if (motion !== token) return;
    token.timer = null;
    if (exiting || window !== target || target.isDestroyed() || (guard && !guard())) { motion = null; return; }
    const elapsed = clamp01((performance.now() - started) / duration);
    const rect = lerpBounds(from, to, ease(elapsed));
    const alpha = opacity ? Number(opacity(elapsed).toFixed(3)) : null;
    if (!painted || rect.x !== painted.x || rect.y !== painted.y || rect.width !== painted.width
        || rect.height !== painted.height || alpha !== painted.alpha) {
      try {
        target.setBounds(rect, false);
        if (alpha !== null) target.setOpacity(alpha);
      } catch { /* a resize is cosmetic; never fail a task over it */ }
      painted = { ...rect, alpha };
    }
    if (elapsed < 1) token.timer = setTimeout(step, FRAME_MS);
    else { motion = null; motionBase = null; done?.(); }
  };
  token.timer = setTimeout(step, 0);
}
function applyDensity(state) {
  if (!window || window.isDestroyed() || !state?.visible || !window.isVisible()) return;
  const size = COMPACT_PHASES.has(state.phase) ? PANEL_COMPACT : PANEL_FULL;
  // Every state update republishes the same phase; only a real density change may move
  // the frame, and a morph already heading for this size must not be restarted.
  if (motion?.size && motion.size.width === size.width && motion.size.height === size.height) return;
  let bounds;
  try { bounds = window.getBounds(); } catch { return; }
  if (bounds.width === size.width && bounds.height === size.height) return;
  const workArea = screen.getDisplayNearestPoint({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }).workArea;
  animateWindow({ to: morphTarget(bounds, size, workArea), duration: MORPH_MS, ease: easeMorph, size });
}

// Exit: the panel is pulled into its own orb instead of dissolving where it stood, so the
// far side of the card travels most of its own width while the near side barely moves.
function absorbWindow(activationId) {
  const target = window;
  if (exiting || !target || target.isDestroyed() || !target.isVisible()) { destroyWindow(activationId); return; }
  let base;
  try { base = target.getBounds(); } catch { destroyWindow(activationId); return; }
  animateWindow({
    to: absorbTarget(base),
    duration: LEAVE_MS,
    ease: easeLeave,
    opacity: absorbOpacity,
    guard: () => !controller?.snapshot().visible,
    done: () => { if (window === target && !controller?.snapshot().visible) destroyWindow(activationId); },
  });
}
function fatal(code, message) {
  if (exiting) return;
  try { send({ v: 1, type: 'fatal', code, message }); } finally { shutdown(1); }
}
function rendererState() {
  const value = controller.snapshot();
  const visible = value.visible && !!window && !window.isDestroyed() && window.isVisible();
  return { ...value, visible };
}
function publish() {
  const state = rendererState();
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(`${prefix}state`, state);
  applyDensity(state);
  clearTimeout(stopTimer); stopTimer = null;
  if (controller?.isCapturing() && !controller.mayCapture()) {
    // Renderer normally acknowledges stopped tracks immediately. Destroy the
    // owned webContents if it is hung instead of trusting a hidden microphone.
    const id = controller.snapshot().activationId;
    stopTimer = setTimeout(() => {
      if (!exiting && controller.snapshot().activationId === id && controller.isCapturing() && !controller.mayCapture()) {
        notice('CAPTURE_STOP_TIMEOUT', '录音组件未及时停止，已释放该原生窗口。'); destroyWindow(id);
      }
    }, 1500);
  }
}
function destroyWindow(activationId) {
  clearTimeout(stopTimer); stopTimer = null;
  stopMotion();
  const previous = window; window = null; loading = null;
  if (revealTarget?.activationId === activationId) revealTarget = null;
  if (previous && !previous.isDestroyed()) previous.destroy();
  // Destroying the renderer releases its MediaStreams and speech synthesis.
  controller?.closed(activationId);
}
function errorCode(error) { return error instanceof ProtocolError ? error.code : 'NATIVE_OPERATION_FAILED'; }
function reportOperationError(error) {
  const code = errorCode(error);
  notice(code, code === 'STALE_ACTIVATION' ? '已忽略过期的语音操作。' : '原生语音操作被拒绝；请关闭后重试。');
}
function shutdown(exitCode = 0) {
  if (exiting) return;
  exiting = true; clearTimeout(initTimer); clearTimeout(stopTimer);
  try { controller?.dispose(); } catch { /* still exit and release renderer */ }
  if (window && !window.isDestroyed()) window.destroy();
  window = null; queued = []; process.stdin.pause();
  for (const method of ['ready', 'audio', 'text', 'action', 'capture']) ipcMain.removeHandler(`${prefix}${method}`);
  // app.exit kills owned renderer/GPU/utility children even with stdin open.
  const force = setTimeout(() => app.exit(exitCode), 200); force.unref();
  if (!process.stdout.destroyed) process.stdout.write('', () => app.exit(exitCode));
  else app.exit(exitCode);
}

function presentWindow(ownedWindow, activationId) {
  const state = controller.snapshot();
  if (exiting || window !== ownedWindow || ownedWindow.isDestroyed() || !state.visible || state.activationId !== activationId || revealTarget?.activationId !== activationId) return;
  cancelMotion();
  if (revealTarget.focus) { ownedWindow.show(); ownedWindow.focus(); }
  else ownedWindow.showInactive();
  publish();
}
async function ensureWindow({ activationId, title, focus = true }) {
  if (exiting || !controller.snapshot().visible || controller.snapshot().activationId !== activationId) return;
  if (revealTarget?.activationId !== activationId) revealTarget = { activationId, focus };
  else if (focus) revealTarget.focus = true; // A stale inactive show cannot undo a completed Host reveal.
  if (window && !window.isDestroyed()) {
    const ownedWindow = window;
    if (loading) await loading;
    presentWindow(ownedWindow, activationId);
    return;
  }
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  // Open at the size this activation will actually use: a shortcut pressed to talk should
  // never appear at full size and then shrink under the cursor.
  const openingState = controller?.snapshot();
  const opening = COMPACT_PHASES.has(openingState?.phase) || openingState?.capture === true ? PANEL_COMPACT : PANEL_FULL;
  const width = Math.min(opening.width, workArea.width), height = Math.min(opening.height, workArea.height);
  const ownedWindow = new BrowserWindow({
    width, height, x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + Math.max(24, workArea.height * 0.16)),
    title, show: false, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: true,
    ...(process.platform === 'darwin'
      ? { type: 'panel', vibrancy: 'under-window', visualEffectState: 'active', roundedCorners: true, backgroundColor: '00000000' }
      : {}),
    webPreferences: { preload: path.join(localDir, 'preload.cjs'), session: featureSession, contextIsolation: true, sandbox: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, plugins: false, devTools: false, spellcheck: false,
      navigateOnDragDrop: false, safeDialogs: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  window = ownedWindow;
  ownedWindow.setMenu(null);
  if (process.platform === 'darwin') ownedWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ownedWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) ownedWindow.webContents.on(eventName, event => event.preventDefault());
  ownedWindow.webContents.on('before-input-event', (event, input) => {
    if (ownedWindow.isFocused() && input.type === 'keyDown' && (input.key === 'Escape' || ((input.meta || input.control) && input.key.toLowerCase() === 'w'))) {
      event.preventDefault();
      if (window === ownedWindow && controller.snapshot().visible) {
        try { controller.renderer('action', { activationId: controller.snapshot().activationId, name: 'cancel' }); } catch (error) { reportOperationError(error); }
      }
    }
  });
  ownedWindow.on('close', event => {
    if (exiting) return;
    event.preventDefault();
    if (window === ownedWindow && controller.snapshot().visible) {
      try { controller.renderer('action', { activationId: controller.snapshot().activationId, name: 'dismiss' }); } catch (error) { reportOperationError(error); }
    }
  });
  ownedWindow.on('closed', () => {
    if (window === ownedWindow) { window = null; loading = null; controller.closed(activationId); }
  });
  ownedWindow.webContents.on('render-process-gone', () => {
    if (window === ownedWindow && !exiting) { notice('RENDERER_EXITED', '语音组件已退出，录音已释放。'); destroyWindow(activationId); }
  });
  const promise = ownedWindow.loadURL(FEATURE_URL);
  loading = promise;
  try {
    await promise;
    presentWindow(ownedWindow, activationId);
  } finally { if (loading === promise) loading = null; }
}

function handleHost(message) {
  if (exiting) return;
  if (message.type === 'shutdown') { shutdown(); return; }
  if (!controller) {
    if (queued.length >= 32) { fatal('COMMAND_QUEUE_LIMIT', 'Too many commands before native readiness.'); return; }
    queued.push(message); return;
  }
  try {
    controller.handleHost(message);
    if (message.type === 'init') { initialized = true; clearTimeout(initTimer); initTimer = null; }
  } catch (error) {
    if (!initialized) fatal(errorCode(error), 'Native helper initialization failed.');
    else reportOperationError(error);
  }
}
const input = createLineDecoder({ onMessage: handleHost, onError: error => fatal(errorCode(error), 'Invalid bounded native transport message.') });
process.stdin.on('data', chunk => input.push(chunk));
process.stdin.on('end', () => shutdown());
process.stdin.on('close', () => shutdown());
process.stdin.on('error', () => shutdown(1));
process.stdout.on('error', () => shutdown(1));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown());
process.on('uncaughtException', () => fatal('UNCAUGHT_EXCEPTION', 'Native helper stopped after an internal error.'));
process.on('unhandledRejection', () => fatal('UNHANDLED_REJECTION', 'Native helper stopped after an asynchronous error.'));
app.on('before-quit', () => { if (!exiting) shutdown(); });
app.on('window-all-closed', () => { /* The owned shortcut remains until parent disables us. */ });

app.whenReady().then(async () => {
  if (exiting) return;
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
  Menu.setApplicationMenu(null);
  const uiRoot = await fs.realpath(path.join(localDir, '../voice-ui'));
  featureSession = session.fromPartition(`workfiles-voice-${randomUUID()}`, { cache: false });
  featureSession.protocol.handle(FEATURE_SCHEME, async request => {
    const name = resourceForURL(request.url);
    if (!name || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
    const file = path.join(uiRoot, name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 || await fs.realpath(file) !== file) return new Response(null, { status: 404 });
      const bytes = request.method === 'HEAD' ? null : await fs.readFile(file);
      return new Response(bytes, { headers: {
        'Content-Type': RESOURCE_TYPES[name], 'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Permissions-Policy': 'microphone=(self), camera=(), display-capture=(), geolocation=(), usb=(), bluetooth=(), hid=(), serial=()',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
      } });
    } catch { return new Response(null, { status: 404 }); }
  });
  featureSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: resourceForURL(details.url) === null }));
  featureSession.on('will-download', event => event.preventDefault());
  featureSession.setDevicePermissionHandler(() => false);
  featureSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  featureSession.setPermissionCheckHandler((webContents, permission, origin, details) => allowAudioPermission({ kind: 'check', permission, origin, details, webContents, window, controller }));
  featureSession.setPermissionRequestHandler((webContents, permission, callback, details) => callback(allowAudioPermission({ kind: 'request', permission, details, webContents, window, controller })));
  controller = createNativeController({
    platform: process.platform, electronVersion: process.versions.electron, send,
    register: (accelerator, callback) => globalShortcut.register(accelerator, () => { try { callback(); } catch (error) { reportOperationError(error); } }),
    unregister: accelerator => globalShortcut.unregister(accelerator),
    onState: publish,
    onHide: ({ activationId, reason }) => reason === 'replacement' ? destroyWindow(activationId) : absorbWindow(activationId),
    onShow: options => { ensureWindow(options).catch(() => { if (!exiting && controller.snapshot().visible && controller.snapshot().activationId === options.activationId) fatal('PANEL_LOAD_FAILED', 'The real native voice panel could not be loaded.'); }); },
  });
  for (const method of ['ready', 'audio', 'text', 'action', 'capture']) {
    ipcMain.handle(`${prefix}${method}`, (event, ...args) => {
      if (exiting || !window || !isTrustedSender(event, window.webContents) || !controller.snapshot().visible) throw new Error('Untrusted native renderer');
      if (method === 'ready') {
        if (args.length) throw new Error('ready takes no arguments');
        return rendererState();
      }
      if (args.length !== 1) throw new Error('Expected one native payload');
      controller.renderer(method, args[0]);
      if (method === 'capture') publish();
    });
  }
  const pending = queued; queued = [];
  for (const message of pending) { if (!exiting) handleHost(message); }
}).catch(() => fatal('NATIVE_START_FAILED', 'Native helper could not initialize.'));
