import { createPcmCapture, isCaptureIntent, selectLocalVoice, wavToBase64 } from './audio.js';
import { PHASE_LABELS, SHORT_FEEDBACK_DISMISS_MS, THREAD_FEEDBACK_DISMISS_MS, selectPanelStatus, selectPanelEcho, updateFeedbackRetention, shouldAutoDismissFeedback, shouldDismissThread, panelActivity, selectPanelItems, selectPanelThread, shouldAutoPrepare, threadOverflow } from './view-state.js';

// This is the real, isolated native feature renderer. It has no file/network/generic IPC API.
const bridge = window.workfilesVoice;
const hasBridge = Boolean(bridge && ['onState', 'ready', 'audio', 'text', 'action', 'capture'].every(name => typeof bridge[name] === 'function'));
// Copy is an optional bridge capability: without it the row simply shows no button.
const canCopy = Boolean(hasBridge && typeof bridge.clipboard === 'function');
// Row clicks are optional too: without the bridge method the rows stay plain text.
const canSelect = Boolean(hasBridge && typeof bridge.select === 'function');
const ui = Object.fromEntries(['status', 'primary', 'cancel', 'echo', 'error', 'detail', 'progress', 'hint', 'level', 'typing-toggle', 'text-form', 'text-input', 'text-submit', 'orb', 'timer', 'content', 'items', 'thread', 'more', 'more-label'].map(id => [id, document.getElementById(id)]));
const panel = document.querySelector('.voice-panel');
const PHASES = new Set(['ready', 'preparing', 'listening', 'transcribing', 'working', 'question', 'done', 'error']);

/* ---------------------------------------------------------------------------
 * Dot-matrix orb: one painter, six motion grammars. It is the only level meter
 * and the only activity indicator in the panel, so nothing else may animate.
 *   rest     — dim, still: nothing is owed to you yet
 *   converge — pulled inward by the real microphone RMS (the only voice-coupled state)
 *   flow     — a hard boundary sweeps once: deterministic progress
 *   scan     — a band sweeps with sparse sparks: searching, no percentage
 *   hold     — bright and still: it is your turn
 *   burst    — one outward shell, then settle: the task really ended
 * Sizes and colours come from CSS custom properties so light/dark still follow the host.
 * ------------------------------------------------------------------------- */
const orbCtx = ui.orb && typeof ui.orb.getContext === 'function' ? ui.orb.getContext('2d') : null;
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map(value => (value + 0.5) / 64);
const orbPalette = { lit: [38, 98, 192], dim: [189, 209, 235] };
let orbStateNow = '';
let orbStateStart = 0;
let orbFrame;
let voiceLevel = 0;
let orbRunning = false;
const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

// Deterministic per-dot hash: single dots can sparkle without looking like noise.
const orbHash = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v); };
const orbMix = (a, b, t) => {
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)} ${Math.round(a[1] + (b[1] - a[1]) * k)} ${Math.round(a[2] + (b[2] - a[2]) * k)})`;
};

function hslToRgb(h, s, l) {
  const sat = s / 100, light = l / 100;
  const k = n => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = n => Math.round(255 * (light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [channel(0), channel(8), channel(4)];
}

function readOrbPalette() {
  // The canvas needs numbers; CSS owns the channels so light/dark still follow the host.
  try {
    const style = window.getComputedStyle(document.documentElement);
    const value = name => parseFloat(String(style.getPropertyValue(name) || '').replace('%', ''));
    const hsl = prefix => {
      const parts = [value(`--${prefix}-h`), value(`--${prefix}-s`), value(`--${prefix}-l`)];
      return parts.every(Number.isFinite) ? parts : null;
    };
    const lit = hsl('voice-pin');
    const dim = hsl('voice-pin-dim');
    if (lit) orbPalette.lit = hslToRgb(lit[0], lit[1], lit[2]);
    if (dim) orbPalette.dim = hslToRgb(dim[0], dim[1], dim[2]);
  } catch { /* keep the last known palette */ }
}

function orbState() {
  // Read the same display phase the CSS sees, so the orb can never disagree with the
  // panel (blocked/typing/pending states are the panel's own, not the Host's).
  const phase = panel.dataset.phase || 'ready';
  if (phase === 'error') return 'rest';
  if (phase === 'listening') return 'converge';
  if (phase === 'preparing' || phase === 'transcribing') return 'flow';
  if (phase === 'working') return 'scan';
  if (phase === 'question') return 'hold';
  if (phase === 'done') return 'burst';
  return 'rest';
}

function paintOrb(state, time, level) {
  if (!orbCtx) return;
  const size = ui.orb.clientWidth;
  if (!size) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixels = Math.round(size * ratio);
  if (ui.orb.width !== pixels || ui.orb.height !== pixels) { ui.orb.width = pixels; ui.orb.height = pixels; }
  orbCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  orbCtx.clearRect(0, 0, size, size);

  const R = size * 0.43;
  const spacing = Math.max(3.6, size / 14.5);
  const center = size / 2;
  const lx = -0.42, ly = -0.52, lz = 0.74;
  const cycle = state === 'burst' ? 2.4 : 0;
  const local = cycle ? (time % cycle) / cycle : 0;
  const scanY = Math.sin(time * 1.1) * R * 0.85;
  const flowP = Math.min(1, (time % 1.75) / 1.55);
  const flowX = -R * 1.06 + flowP * R * 2.12;
  const dim = state === 'rest';

  for (let gy = -R; gy <= R; gy += spacing) {
    for (let gx = -R; gx <= R; gx += spacing) {
      const gridDist = Math.hypot(gx, gy);
      if (gridDist > R) continue;

      let x = gx, y = gy, radiusScale = 1, glow = 0, extraAlpha = 0;

      if (state === 'converge') {
        const pull = (0.06 + 0.20 * level) * (0.65 + 0.35 * Math.sin(time * 3.4));
        x = gx * (1 - pull); y = gy * (1 - pull);
        glow = Math.exp(-Math.pow(gridDist / R, 2) * 2.4) * (0.35 + 0.65 * level);
        radiusScale = 0.86 + 0.30 * level;
      } else if (state === 'scan') {
        const band = Math.exp(-Math.pow((gy - scanY) / (R * 0.24), 2));
        const sparkle = orbHash(gx, gy) > 0.88 ? Math.max(0, Math.sin(time * 5 + orbHash(gy, gx) * 12)) : 0;
        x = gx + band * Math.sin(time * 9 + orbHash(gx, gy) * 8) * 0.9;
        glow = 0.1 + band * 1.0 + sparkle * 0.65;
        radiusScale = 0.72 + band * 0.7 + sparkle * 0.3;
        extraAlpha = sparkle * 0.6;
      } else if (state === 'flow') {
        const passed = gx < flowX;
        const edge = Math.abs(gx - flowX) < spacing * 1.2;
        const dither = BAYER[((Math.round(gy / spacing) % 8) + 8) % 8 * 8 + ((Math.round(gx / spacing) % 8) + 8) % 8];
        if (edge && dither < 0.5) { radiusScale = 0.5; glow = 0.2; }
        else if (passed) { glow = 0.92 + 0.1 * Math.sin((gy / spacing) * 0.5 + time * 6); radiusScale = 1.08; }
        else { glow = 0.015; radiusScale = 0.58; }
      } else if (state === 'hold') {
        glow = 0.6 + 0.07 * Math.sin(time * 1.35);
        radiusScale = 1.0 + 0.02 * Math.sin(time * 1.35);
      } else if (state === 'burst') {
        const settle = local > 0.55;
        const blast = Math.min(1, local / 0.55);
        const ringR = settle ? R * 0.26 : R * (0.12 + blast * 1.32);
        const collapse = settle ? 1 - Math.min(1, (local - 0.55) / 0.3) * 0.52 : 1;
        x = gx * collapse; y = gy * collapse;
        const shell = Math.exp(-Math.pow((gridDist - ringR) / (R * (settle ? 0.14 : 0.11)), 2));
        glow = 0.12 + shell * (settle ? 0.85 : 1);
        radiusScale = settle ? 1.05 : 0.6 + shell * 1.25;
        extraAlpha = shell * (settle ? 0.35 : 0.6);
      } else {
        glow = 0;
        radiusScale = 0.8 + 0.05 * Math.sin(time * 0.9);
      }

      const dist = Math.hypot(x, y);
      const z = Math.sqrt(Math.max(0, R * R - dist * dist)) / R;
      const nx = dist > 0 ? x / R : 0, ny = dist > 0 ? y / R : 0;
      const light = Math.pow(Math.max(0, nx * lx + ny * ly + z * lz), 1.5);
      const sphere = 0.3 + 0.7 * z;
      const edgeFade = Math.min(1, (R - dist) / (spacing * 0.4));
      const dotRadius = spacing * 0.44 * sphere * radiusScale * (0.42 + 0.8 * light) * edgeFade;
      if (dotRadius <= 0.18) continue;

      const shade = Math.min(1, Math.max(0, 1 - light * 0.95));
      const base = 0.16 + 0.84 * Math.max(0, Math.min(1, 0.3 * light + glow));
      orbCtx.globalAlpha = Math.min(1, base * (dim ? 0.72 : 1));
      orbCtx.fillStyle = orbMix(orbPalette.lit, orbPalette.dim, shade * 0.85 - glow * 0.45);
      orbCtx.beginPath();
      orbCtx.arc(center + x, center + y, dotRadius, 0, Math.PI * 2);
      orbCtx.fill();

      if (glow > 0.78 || extraAlpha > 0.4) {
        orbCtx.globalAlpha = Math.min(1, (glow * 0.7 + extraAlpha) * (dim ? 0.72 : 1));
        orbCtx.fillStyle = orbMix(orbPalette.lit, orbPalette.lit, 0);
        orbCtx.beginPath();
        orbCtx.arc(center + x, center + y, dotRadius * 0.5, 0, Math.PI * 2);
        orbCtx.fill();
      }
    }
  }
  orbCtx.globalAlpha = 1;
}

function orbTick(now) {
  if (disposed || !orbRunning) return;
  orbFrame = window.requestAnimationFrame(orbTick);
  if (document.visibilityState === 'hidden') return;
  const state = orbState();
  if (state !== orbStateNow) { orbStateNow = state; orbStateStart = now; }
  paintOrb(state, (now - orbStateStart) / 1000, voiceLevel);
}

function syncOrb() {
  const animate = Boolean(orbCtx) && !reducedMotion?.matches;
  if (animate && !orbRunning) { orbRunning = true; orbFrame = window.requestAnimationFrame(orbTick); }
  else if (!animate && orbRunning) { orbRunning = false; window.cancelAnimationFrame(orbFrame); }
  if (!animate && orbCtx) {
    // Reduced motion still gets the state, just as one still frame.
    const state = orbState();
    if (state !== orbStateNow) { orbStateNow = state; orbStateStart = 0; }
    paintOrb(state, 0.6, voiceLevel);
  }
}
const ERRORS = {
  'permission-denied': '麦克风权限未获允许。可在系统设置中允许后重试，或用键盘输入。',
  'permission-timeout': '等待麦克风授权超时，已停止本次请求。可重试或用键盘输入。',
  'input-unavailable': '麦克风不可用或正被占用。请检查输入设备后重试。',
  'input-ended': '麦克风连接已中断，请重新连接后重试。',
  'audio-processing-failed': '录音处理失败，麦克风已停止。请重试。',
  'encoding-failed': '录音编码失败，麦克风已停止。请重试。',
  'capture-unavailable': '无法开始录音。请检查麦克风权限，或用键盘输入。',
};
const HOST_RESPONSE_TIMEOUT_MS = 120000;
let host = { activationId: '', capture: false, listen: false, visible: true, phase: 'ready', message: '', detail: '', items: [], turns: [] };
const retiredActivations = new Set();
let disposed = false;
let unsubscribe;
let listenIntent = 0;
let consumedIntent = -1;
let preparedActivation = '';
let lastSignalId = -1;
let attempt;
let captureActive = false;
let elapsedMs = 0;
let localError = '';
let localNotice = '';
let userBlocked = false;
let typingOpen = false;
let actionPending;
let submission;
let uncertainText;
let operationTimer;
let doneTimer;
let doneKey = '';
// Declared with the other panel state: the timer policy reads it before the listeners below
// are wired, and a state that arrives during setup must not hit a temporal dead zone.
let readerScrolled = false;
let feedbackRetention = updateFeedbackRetention(undefined, undefined);
let speech;
let speechEpoch = 0;
let speechTailTimer;
let resolvedQuestion = '';

// Exit: the helper pulls the frame into the orb on its own clock. The card is pinned to
// the size it had when the exit began and scaled by exactly the same factor, so the whole
// surface shrinks into the orb instead of being clipped by a closing frame — and because
// nothing re-lays out, the sentence can never re-wrap mid-collapse.
let leaveFrame;
function followLeaveScale() {
  if (disposed || panel.dataset.pinned !== '1') { leaveFrame = undefined; return; }
  const width = Number.parseFloat(panel.style.getPropertyValue('--voice-leave-w')) || 0;
  if (width > 0) {
    const scale = Math.max(0, Math.min(1, window.innerWidth / width));
    panel.style.setProperty('--voice-leave-scale', String(Math.round(scale * 1000) / 1000));
  }
  leaveFrame = window.requestAnimationFrame(followLeaveScale);
}
function pinContent() {
  if (panel.dataset.pinned === '1') return;
  const rect = panel.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  panel.style.setProperty('--voice-leave-w', `${Math.round(rect.width)}px`);
  panel.style.setProperty('--voice-leave-h', `${Math.round(rect.height)}px`);
  panel.style.setProperty('--voice-leave-scale', '1');
  panel.classList.add('is-leaving');
  panel.dataset.pinned = '1';
  followLeaveScale();
}
function unpinContent() {
  if (leaveFrame !== undefined) { window.cancelAnimationFrame(leaveFrame); leaveFrame = undefined; }
  panel.classList.remove('is-leaving');
  delete panel.dataset.pinned;
}

// The page loads before the first Host snapshot, so the interior must not animate its own
// metrics towards a density the frame has not adopted yet. The guard lifts one task later,
// after the first state has been applied at zero duration (a timer, not a frame callback:
// the window may still be hidden when the state arrives).
let mounted = false;
function settleDensity() {
  if (mounted) return;
  mounted = true;
  window.setTimeout(() => panel.classList.remove('is-mounted'), 0);
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Local wall-clock stamp for a row; the state only carries the opaque ISO string. */
function shortStamp(value) {
  const time = Date.parse(typeof value === 'string' ? value : '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time); const pad = number => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

let itemsKey = '';
// 16px geometry for the row actions. Shapes only: no icon font, no image request, so the
// page keeps its single-surface CSP and stays crisp at any backing scale.
const SVG_NS = 'http://www.w3.org/2000/svg';
function glyph(paths, { fill = false } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', fill ? 'currentColor' : 'none');
  svg.setAttribute('stroke', fill ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
const COPY_GLYPH = ['M9 9h9v11H9z', 'M6 15H4V4h9v2'];
const COPIED_GLYPH = ['M5 13l4.5 4.5L19 6'];
const FAILED_GLYPH = ['M7 7l10 10', 'M17 7L7 17'];

// Rows are display-only: a type chip, the name, short location, and — when the bridge
// supports it — a button that copies the exact path or saved link the Host supplied.
function rowNode(row, index = null) {
  const clickable = index !== null && index >= 0 && canSelect;
  // Deliberately not a <button>: the row also holds the copy control, and a button may not
  // contain another button. A click on copy would bubble into the row and open the document
  // as well as copy it, which is exactly the double action this panel must never perform.
  const item = document.createElement('div');
  item.className = clickable ? 'voice-item is-clickable' : 'voice-item';
  if (clickable) {
    item.dataset.index = String(index);
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `打开：${row.name}`);
    item.title = '打开这一条';
    item.addEventListener('click', () => requestRow(index, item));
    item.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      requestRow(index, item);
    });
  }
  if (row.type) { const chip = document.createElement('span'); chip.className = 'voice-item-type'; chip.textContent = row.type; item.append(chip); }
  const name = document.createElement('span'); name.className = 'voice-item-name'; name.textContent = row.name;
  const meta = document.createElement('span'); meta.className = 'voice-item-meta';
  meta.textContent = [row.folderLabel, shortStamp(row.modifiedAt)].filter(Boolean).join(' · ');
  item.append(name, meta);
  if (canCopy && row.copy) item.append(copyButton(row));
  return item;
}

/** The renderer holds no id: it sends "row N of the state I am showing" and lets the Host
 * resolve it through the ordinary candidate gate. */
function requestRow(index, node) {
  if (!canSelect || !host.activationId) return;
  if (node.dataset.pending === '1') return;
  node.dataset.pending = '1';
  node.setAttribute('aria-disabled', 'true');
  const settle = () => { delete node.dataset.pending; node.removeAttribute('aria-disabled'); };
  try {
    Promise.resolve(bridge.select({ activationId: host.activationId, index })).catch(settle);
  } catch {
    settle();
  }
}

function renderItems() {
  const rows = selectPanelItems({ phase: host.phase, items: host.items });
  const key = rows.map(row => [row.name, row.folderLabel, row.modifiedAt, row.type, row.copy].join('\u0001')).join('\u0002');
  if (key === itemsKey) return;
  itemsKey = key;
  if (!rows.length) { ui.items.replaceChildren(); ui.items.hidden = true; return; }
  ui.items.replaceChildren(...rows.map((row, index) => rowNode(row, index)));
  ui.items.hidden = false;
}

/** The conversation so far. Two or more turns take over the card: the transcript replaces
 * the single-line result, the current turn keeps the live line below it, and anything the
 * transcript cannot show is announced by the pill in the action row. */
let threadKey = '';
function renderThread() {
  const turns = selectPanelThread({ turns: host.turns });
  // As soon as the Host has the user's words, the card is a conversation. That happens at
  // submit, so the listening composition becomes a transcript once, at the moment the task
  // starts — never again when the answer arrives.
  const threaded = turns.length >= 1;
  panel.classList.toggle('is-thread', threaded);
  ui.thread.hidden = !threaded;
  if (!threaded) {
    if (threadKey) { threadKey = ''; ui.thread.replaceChildren(); }
    syncOverflow();
    return;
  }
  // The current result already ends the transcript; do not draw those rows twice.
  ui.items.hidden = true;
  const key = turns.map(turn => `${turn.role}\u0001${turn.text}\u0001${(turn.items || []).map(row => [row.name, row.type, row.folderLabel, row.modifiedAt].join('|')).join(',')}`).join('\u0002');
  if (key !== threadKey) {
    const atEnd = ui.thread.scrollHeight - ui.thread.scrollTop - ui.thread.clientHeight < 12;
    threadKey = key;
    const lastAssistant = turns.map(turn => turn.role).lastIndexOf('assistant');
    ui.thread.replaceChildren(...turns.map((turn, turnIndex) => {
      const node = document.createElement('div');
      // The newest turn is the one that owns the card; earlier ones stay readable but
      // recede, so a glance lands on the answer rather than on the history above it.
      node.className = `voice-turn is-${turn.role}${turnIndex === turns.length - 1 ? '' : ' is-older'}`;
      if (turn.role === 'user') {
        const who = document.createElement('span'); who.className = 'voice-turn-who'; who.textContent = '你';
        const say = document.createElement('span'); say.className = 'voice-turn-say'; say.textContent = turn.text;
        node.append(who, say);
      } else {
        const say = document.createElement('span'); say.className = 'voice-turn-say'; say.textContent = turn.text;
        node.append(say);
        if (turn.items && turn.items.length) {
          const list = document.createElement('ul'); list.className = 'voice-rows';
          // Only the newest turn's rows are still resolvable Host-side; older ones are history.
          const liveRows = turnIndex === lastAssistant;
          list.append(...turn.items.map((row, index) => rowNode(row, liveRows ? index : null)));
          node.append(list);
        }
      }
      return node;
    }));
    readerScrolled = false;
    if (atEnd || !threadKey) ui.thread.scrollTop = ui.thread.scrollHeight;
  }
  syncOverflow();
}

/** Say how much is out of view instead of leaving it to a hidden scrollbar. */
function syncOverflow() {
  const thread = ui.thread;
  if (thread.hidden || !thread.clientHeight) {
    ui.more.hidden = true;
    delete thread.dataset.fade;
    return;
  }
  // Bottom-align a conversation that fits, and never while it overflows (see panel.css).
  const fits = thread.scrollHeight <= thread.clientHeight + 1;
  if (thread.dataset.align !== (fits ? 'end' : 'start')) thread.dataset.align = fits ? 'end' : 'start';
  // Measure against the scroll container's own viewport, not offsetTop: the transcript can
  // be bottom-aligned, and offsetTop is relative to a different ancestor in that case.
  const view = thread.getBoundingClientRect();
  const turns = [...thread.children];
  // Partly visible content is still hidden content: count a turn whenever any of it is
  // outside the viewport, on the side it is clipped.
  const above = turns.filter(node => node.getBoundingClientRect().top < view.top - 4).length;
  const below = turns.filter(node => node.getBoundingClientRect().bottom > view.bottom + 4).length;
  const { edge, label } = threadOverflow({ above, below });
  ui.more.hidden = !edge;
  if (edge) {
    ui.more.dataset.edge = edge;
    if (ui['more-label'].textContent !== label) ui['more-label'].textContent = label;
  }
  thread.dataset.fade = above && below ? 'both' : below ? 'bottom' : above ? 'top' : 'off';
}

function copyButton(row) {
  const isLink = row.copyKind === 'link';
  const label = isLink ? '复制链接' : '复制路径';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'voice-item-copy';
  button.setAttribute('aria-label', label);
  button.title = label;
  const draw = (paths, fill) => button.replaceChildren(glyph(paths, { fill }));
  draw(COPY_GLYPH);
  button.addEventListener('click', async event => {
    // A copy must never also be a click on the row it sits in.
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    const finish = (paths, state, message, delay) => {
      draw(paths, state === 'copied');
      button.dataset.state = state;
      button.title = message;
      window.setTimeout(() => {
        button.dataset.state = '';
        button.disabled = false;
        button.title = label;
        draw(COPY_GLYPH);
      }, delay);
    };
    try {
      await Promise.resolve(bridge.clipboard({ text: row.copy }));
      finish(COPIED_GLYPH, 'copied', isLink ? '链接已复制' : '路径已复制', 1200);
    } catch {
      finish(FAILED_GLYPH, 'failed', '复制失败', 1600);
    }
  });
  return button;
}

function showText(node, text) {
  // Host/Agent/typed/OS text is always data. Never parse it as HTML or a URL.
  const value = typeof text === 'string' ? text : '';
  if (node.textContent !== value) node.textContent = value;
  node.hidden = !value;
}

function clearDoneTimer() {
  window.clearTimeout(doneTimer);
  doneTimer = undefined;
  doneKey = '';
}

function readingFeedback() {
  const nodes = [ui.echo, ui.detail].filter(node => !node.hidden);
  if (nodes.some(node => node.contains(document.activeElement))) return true;
  try {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && nodes.some(node => node.contains(selection.anchorNode) || node.contains(selection.focusNode)));
  } catch { return false; }
}

function feedbackOverflows() {
  return [ui.echo, ui.detail].some(node => !node.hidden && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1));
}

/** Reading a transcript counts as intent too: a selection or focus inside it means the
 * card is being used, not abandoned. */
function threadReading() {
  if (ui.thread.hidden) return false;
  if (ui.thread.contains(document.activeElement)) return true;
  try {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed
      && (ui.thread.contains(selection.anchorNode) || ui.thread.contains(selection.focusNode)));
  } catch { return false; }
}

/** A finished conversation may leave on its own, but only when it is entirely visible and
 * untouched: the moment something is clipped, scrolled, selected or typed into, it stays
 * until the user closes it (or the Host's long idle backstop fires). */
function mayCollapseThread() {
  return panel.classList.contains('is-thread') && shouldDismissThread(host, {
    overflow: !ui.thread.hidden && !ui.more.hidden,
    retained: feedbackRetention.retained,
    reading: readerScrolled,
    keyboardOpen: typingOpen,
    hasError: Boolean(localError),
    hasNotice: Boolean(localNotice),
    pageVisible: document.visibilityState !== 'hidden',
  });
}

function mayDismissFeedback() {
  return host.phase === 'done' && shouldAutoDismissFeedback(host, {
    retained: feedbackRetention.retained, reading: readingFeedback(), overflowing: feedbackOverflows(),
    keyboardOpen: typingOpen, hasError: Boolean(localError), pageVisible: document.visibilityState !== 'hidden',
  });
}

function retainFeedbackForReading() {
  if (disposed || host.phase !== 'done') return;
  feedbackRetention = updateFeedbackRetention(feedbackRetention, host, true);
  clearDoneTimer();
  render();
}

function syncFeedbackTimer() {
  const threaded = panel.classList.contains('is-thread');
  feedbackRetention = updateFeedbackRetention(feedbackRetention, host,
    host.phase === 'done' && (typingOpen || readingFeedback() || threadReading()));
  const eligible = threaded ? mayCollapseThread() : mayDismissFeedback();
  if (!eligible) { clearDoneTimer(); return; }
  const key = `${feedbackRetention.key}\u0000${threaded ? 'thread' : 'line'}`;
  if (doneKey === key && doneTimer !== undefined) return;
  clearDoneTimer();
  doneKey = key;
  doneTimer = window.setTimeout(() => {
    doneTimer = undefined;
    // Recheck focus/selection/overflow and the exact result at the firing boundary.
    feedbackRetention = updateFeedbackRetention(feedbackRetention, host, readingFeedback() || threadReading());
    const stillIdle = threaded ? mayCollapseThread() : mayDismissFeedback();
    if (!disposed && doneKey === key && stillIdle) requestAction('dismiss');
    else { clearDoneTimer(); render(); }
  }, threaded ? THREAD_FEEDBACK_DISMISS_MS : SHORT_FEEDBACK_DISMISS_MS);
}

function clearOperationTimer() {
  window.clearTimeout(operationTimer);
  operationTimer = undefined;
}

function safeCaptureFact(activationId, active) {
  if (!hasBridge) return;
  try { Promise.resolve(bridge.capture({ activationId, active })).catch(() => {}); } catch { /* Tracks are already handled locally. */ }
}

function stopCapture() {
  const previous = attempt;
  attempt = undefined; // Invalidate the callback token before cleanup can reenter it.
  if (previous) {
    previous.cancelled = true;
    previous.recorder.cancel();
  }
  captureActive = false;
  elapsedMs = 0;
  voiceLevel = 0;
  ui.level.value = 0;
  panel.style.setProperty('--voice-level', '0');
}

function questionKey(state = host) {
  return `${state.activationId}\u0000${state.phase === 'question' ? state.message : ''}`;
}

function stopSpeech() {
  speechEpoch++;
  const ownedOutput = Boolean(speech || speechTailTimer !== undefined);
  window.clearTimeout(speechTailTimer);
  speechTailTimer = undefined;
  if (speech) {
    window.clearTimeout(speech.timer);
    speech.utterance.onend = speech.utterance.onerror = null;
    speech = undefined;
  }
  if (ownedOutput) {
    try { window.speechSynthesis?.cancel(); } catch { /* A busy output gate still prevents capture. */ }
  }
}

function outputIsBusy() {
  try {
    return window.speechSynthesis?.speaking === true || window.speechSynthesis?.pending === true;
  } catch { return true; } // If we cannot prove output stopped, do not open input.
}

function stopAll() {
  stopCapture();
  stopSpeech();
  clearDoneTimer();
  clearOperationTimer();
  submission = undefined;
  actionPending = undefined;
}

function canListen() {
  return !disposed && hasBridge && !userBlocked && !typingOpen
    && document.visibilityState !== 'hidden' && !outputIsBusy() && isCaptureIntent(host);
}

function beginOperationTimeout(activationId) {
  clearOperationTimer();
  operationTimer = window.setTimeout(() => {
    if (disposed || host.activationId !== activationId) return;
    stopAll();
    userBlocked = true;
    consumedIntent = listenIntent;
    localError = '本次任务等待超时，已请求取消。请重试。';
    localNotice = '';
    // Cancels admitted server work too; merely abandoning a renderer Promise is insufficient.
    try { Promise.resolve(bridge.action({ activationId, name: 'cancel' })).catch(() => {}); } catch { /* Show the retryable error. */ }
    render();
  }, HOST_RESPONSE_TIMEOUT_MS);
}

function markSendFailure(token, message) {
  if (disposed || submission !== token || host.activationId !== token.activationId) return;
  submission = undefined;
  clearOperationTimer();
  userBlocked = true;
  localError = message;
  render();
}

function finalAudio(current, result) {
  if (disposed || attempt !== current || current.cancelled || current.submitted || host.activationId !== current.activationId) return;
  current.submitted = true; // Commit once, before encoding/IPC or any reentrant callback.
  attempt = undefined;
  captureActive = false;
  elapsedMs = 0;
  userBlocked = true; // An unchanged listen:true snapshot is not a new utterance.
  if (!result.hasSpeech || !result.wav) {
    // No empty ASR admission. Native disarms and retires this activation/window;
    // the next shortcut/record click is a fresh explicit attempt, not an old listen.
    requestAction('cancel', '没有听到说话，本次录音已结束。');
    return;
  }
  try {
    const token = { activationId: current.activationId, utteranceId: window.crypto.randomUUID(), kind: 'audio' };
    const wavBase64 = wavToBase64(result.wav);
    // Cancellation/activation tokens are checked again at the actual send boundary.
    if (disposed || current.cancelled || host.activationId !== current.activationId) return;
    submission = token;
    localError = localNotice = '';
    beginOperationTimeout(token.activationId);
    render();
    Promise.resolve(bridge.audio({ activationId: token.activationId, utteranceId: token.utteranceId, wavBase64 }))
      .catch(() => markSendFailure(token, '录音已停止，但发送失败。请重试或用键盘输入。'));
  } catch {
    submission = undefined;
    clearOperationTimer();
    localError = '无法提交录音，麦克风已停止。请重试或用键盘输入。';
    render();
  }
}

function beginCapture() {
  if (!canListen() || attempt || speech || speechTailTimer !== undefined || consumedIntent === listenIntent || submission) return;
  consumedIntent = listenIntent;
  localError = localNotice = '';
  const current = { activationId: host.activationId, cancelled: false, submitted: false, recorder: undefined };
  current.recorder = createPcmCapture({
    isAllowed: () => attempt === current && !current.cancelled && canListen() && !speech && speechTailTimer === undefined,
    onActive(active) {
      safeCaptureFact(current.activationId, active);
      if (attempt === current) {
        captureActive = active;
        render();
      }
    },
    onLevel(level) {
      if (attempt !== current || current.cancelled) return;
      elapsedMs = level.elapsedMs;
      const value = Math.min(1, level.rms * 5);
      ui.level.value = value;
      voiceLevel = value;
      panel.style.setProperty('--voice-level', String(value.toFixed(3)));
      render();
    },
    onResult: result => finalAudio(current, result),
    onError(error) {
      if (attempt !== current || current.cancelled || host.activationId !== current.activationId) return;
      attempt = undefined;
      captureActive = false;
      userBlocked = true;
      localError = ERRORS[error?.code] || ERRORS['capture-unavailable'];
      render();
    },
  });
  attempt = current;
  // start() alone may request permission. Importing/constructing/ready()/peek never does.
  void current.recorder.start();
  render();
}

function speakQuestion() {
  const key = questionKey();
  if (!canListen() || host.phase !== 'question' || resolvedQuestion === key || speech) return;
  stopCapture(); // Never leave an input stream alive during local speech output.
  stopSpeech();
  const synth = window.speechSynthesis;
  let voice;
  try { voice = selectLocalVoice(synth?.getVoices?.(), 'zh-CN'); } catch { /* Fall back to text, not a remote voice. */ }
  if (!voice || !host.message || typeof window.SpeechSynthesisUtterance !== 'function') {
    resolvedQuestion = key;
    beginCapture();
    return;
  }
  const epoch = speechEpoch;
  const activationId = host.activationId;
  let utterance;
  try {
    utterance = new window.SpeechSynthesisUtterance(host.message);
    utterance.voice = voice; // Only localService:true voices can reach speak().
    utterance.lang = voice.lang;
    utterance.rate = 1;
  } catch {
    resolvedQuestion = key;
    beginCapture();
    return;
  }
  const current = { key, epoch, utterance, timer: undefined };
  const finished = () => {
    if (disposed || speech !== current || speechEpoch !== epoch || host.activationId !== activationId) return;
    stopSpeech();
    resolvedQuestion = key;
    // Allow the final output tail to decay before any new input is opened.
    speechTailTimer = window.setTimeout(() => {
      speechTailTimer = undefined;
      if (host.activationId === activationId && questionKey() === key) reconcile();
    }, 200);
    render();
  };
  utterance.onend = utterance.onerror = finished;
  current.timer = window.setTimeout(finished, 30000);
  speech = current;
  render();
  try { synth.cancel(); synth.speak(utterance); } catch { finished(); }
}

function reconcile() {
  if (!canListen() || submission || speech || speechTailTimer !== undefined) return;
  if (host.phase === 'question' && resolvedQuestion !== questionKey()) speakQuestion();
  else beginCapture();
}

/** One row shape for anything the Host sends: the current result and every transcript
 * turn use it, so the renderer never has to know which list it is looking at. */
function hostRows(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap(item => item && typeof item.name === 'string' && item.name.trim() ? [{
    name: item.name.slice(0, 300),
    ...(typeof item.folder === 'string' ? { folder: item.folder.slice(0, 4096) } : {}),
    ...(typeof item.modifiedAt === 'string' ? { modifiedAt: item.modifiedAt.slice(0, 64) } : {}),
    ...(typeof item.type === 'string' ? { type: item.type.slice(0, 8) } : {}),
    ...(typeof item.copy === 'string' ? { copy: item.copy.slice(0, 4096) } : {}),
    ...(item.copyKind === 'link' || item.copyKind === 'path' ? { copyKind: item.copyKind } : {}),
  }] : []);
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || !PHASES.has(value.phase)) return null;
  if (value.activationId != null && (typeof value.activationId !== 'string' || value.activationId.length > 128)) return null;
  return {
    activationId: value.activationId || '', capture: value.capture === true, listen: value.listen === true,
    visible: value.visible !== false, phase: value.phase,
    message: typeof value.message === 'string' ? value.message.slice(0, 1000) : '',
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 1000) : '',
    canPrepare: value.canPrepare === true,
    items: hostRows(value.items),
    turns: Array.isArray(value.turns) ? value.turns.slice(-8).flatMap(turn => {
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.text !== 'string' || !turn.text.trim()) return [];
      const items = turn.role === 'assistant' ? hostRows(turn.items) : [];
      return [{ role: turn.role, text: turn.text.slice(0, 600), items }];
    }) : [],
    progress: Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1 ? value.progress : undefined,
    signal: value.signal === 'stop-submit' ? value.signal : undefined,
    signalId: Number.isSafeInteger(value.signalId) && value.signalId >= 0 ? value.signalId : undefined,
  };
}

function applyState(value) {
  if (disposed) return;
  const next = normalizeState(value);
  if (!next || (next.activationId && retiredActivations.has(next.activationId))) return;
  const previous = host;
  const changedActivation = next.activationId !== previous.activationId;
  const changedQuestion = next.phase === 'question'
    && (previous.phase !== 'question' || next.message !== previous.message);
  if (changedActivation) {
    if (previous.activationId) retiredActivations.add(previous.activationId);
    stopAll();
    localError = localNotice = '';
    userBlocked = false;
    typingOpen = false;
    ui['text-input'].value = '';
    uncertainText = undefined;
    resolvedQuestion = '';
    consumedIntent = -1;
    lastSignalId = -1;
  }
  host = next;
  if (shouldAutoPrepare({ phase: next.phase, canPrepare: next.canPrepare, captureIntent: isCaptureIntent(next), activationId: next.activationId, prepared: preparedActivation })) {
    preparedActivation = next.activationId;
    requestAction('prepare');
  }
  const nextIntent = isCaptureIntent(next);
  if (nextIntent && (changedActivation || !isCaptureIntent(previous) || changedQuestion)) {
    listenIntent++;
    // Only a fresh Host listen grant/new question may follow an already submitted turn.
    if (!typingOpen) userBlocked = false;
    localError = localNotice = '';
  }
  const stopSignal = next.signal === 'stop-submit' && next.signalId !== undefined && next.signalId > lastSignalId;
  if (stopSignal) lastSignalId = next.signalId;
  // This trusted one-shot native signal is processed before capture:false/listen:false.
  // All ordinary disarms/cancellations discard audio instead of submitting it.
  if (stopSignal && !changedActivation && attempt && next.visible
      && (next.phase === 'listening' || next.phase === 'question')) {
    attempt.recorder.finish('shortcut');
  } else if (!nextIntent || changedQuestion) {
    stopCapture();
  }
  if (!nextIntent || changedQuestion) stopSpeech();
  if (!next.visible || !next.activationId) {
    stopAll();
    userBlocked = true;
    typingOpen = false;
  }
  if (next.phase !== 'done') clearDoneTimer();
  const stateAdvanced = changedActivation || next.phase !== previous.phase || next.message !== previous.message;
  if (stateAdvanced && ['ready', 'preparing', 'transcribing', 'working', 'question', 'done', 'error'].includes(next.phase)) {
    if (submission?.kind === 'text' && submission.activationId === next.activationId
        && ['transcribing', 'working', 'question', 'done'].includes(next.phase)) {
      // The Host may advance before the native IPC acknowledgement resolves.
      // Clear accepted text once, but retain keyboard mode until an explicit voice retry.
      ui['text-input'].value = '';
      uncertainText = undefined;
    }
    submission = undefined;
    actionPending = undefined;
  }
  if (stateAdvanced && ['ready', 'question', 'done', 'error'].includes(next.phase)) clearOperationTimer();
  feedbackRetention = updateFeedbackRetention(feedbackRetention, host, host.phase === 'done' && (typingOpen || readingFeedback()));
  render();
  settleDensity();
  syncFeedbackTimer();
  reconcile();
}

function requestAction(name, cancelNotice = '') {
  if (disposed || !hasBridge || !host.activationId) return;
  const activationId = host.activationId;
  stopAll();
  userBlocked = true;
  consumedIntent = listenIntent;
  localError = '';
  localNotice = name === 'cancel' ? cancelNotice || '已停止录音，正在取消任务…' : '';
  if (name === 'cancel' || name === 'dismiss') typingOpen = false;
  if (name === 'retry') {
    typingOpen = false;
    ui['text-input'].value = '';
    uncertainText = undefined;
  }
  const token = { activationId, name };
  actionPending = token;
  render();
  try {
    Promise.resolve(bridge.action({ activationId, name })).then(() => {
      if (disposed || actionPending !== token || host.activationId !== activationId) return;
      actionPending = undefined;
      if (name === 'cancel') localNotice = cancelNotice || '录音已停止，已请求取消本次任务。';
      render();
      // retry does not reuse an old Host listen snapshot. Native creates a new armed UUID.
    }).catch(() => {
      if (disposed || actionPending !== token || host.activationId !== activationId) return;
      actionPending = undefined;
      localError = name === 'cancel' ? '麦克风已停止，但取消请求未送达。请重试。' : '请求未送达，请重试。';
      render();
    });
  } catch {
    actionPending = undefined;
    localError = '原生语音组件未响应，请重试。';
    render();
  }
}

function toldText() {
  const invitation = !host.message && !localError && !attempt && host.phase === 'ready' ? '说一句要找什么' : '';
  const told = selectPanelEcho({ phase: host.phase, message: host.message, captureActive }) || invitation;
  // Once the user's words are in the transcript, repeating them on the live line would say
  // the same thing twice in one card.
  const lastTurn = selectPanelThread({ turns: host.turns }).at(-1);
  return lastTurn && lastTurn.text === told ? '' : told;
}

function render() {
  if (disposed) return;
  if (!host.visible) pinContent();
  else if (panel.dataset.pinned === '1') unpinContent();
  const exists = hasBridge && Boolean(host.activationId) && host.visible;
  // The card is a conversation as soon as the Host has the user's words; before that it is
  // the live stage, which shows the same frame with a prompt instead of a transcript.
  const turnsNow = selectPanelThread({ turns: host.turns });
  const live = exists && turnsNow.length === 0;
  const recording = Boolean(attempt);
  const busy = Boolean(submission) || ['preparing', 'transcribing', 'working'].includes(host.phase);
  const needsExplicitStart = !recording && !speech && !submission && !busy && !host.canPrepare
    && (userBlocked || consumedIntent === listenIntent);
  const status = selectPanelStatus({
    hasBridge, activationId: host.activationId, phase: host.phase, keyboardOpen: typingOpen,
    captureActive, recording, elapsedMs, speaking: Boolean(speech), submitting: Boolean(submission),
    hasError: Boolean(localError), hasNotice: Boolean(localNotice), needsExplicitStart,
  });
  // While the microphone is open the big tabular timer is the proof of recording, so the
  // subtitle stops counting seconds and says what stops it instead.
  const listeningNow = captureActive && Boolean(attempt);
  const shownStatus = listeningNow ? '正在听 · 停顿约 1.1 秒自动提交' : status;
  if (ui.status.textContent !== shownStatus) ui.status.textContent = shownStatus;
  ui.status.title = status;
  // Hide it visually when the result sentence already says it, but keep it announced.
  const redundantStatus = host.phase === 'done' && Boolean(host.message) && !localNotice && !listeningNow;
  // A live card that already says "正在识别你刚才的话" must not repeat "正在识别…" under it.
  const genericStatus = shownStatus === PHASE_LABELS[host.phase] && !listeningNow;
  ui.status.classList.toggle('sr-only', redundantStatus || (live && Boolean(toldText()) && genericStatus));
  panel.classList.toggle('is-typing', typingOpen);
  if (ui.timer) {
    if (listeningNow) {
      const stamp = formatElapsed(elapsedMs);
      if (ui.timer.textContent !== stamp) ui.timer.textContent = stamp;
      ui.timer.hidden = false;
    } else if (!ui.timer.hidden) {
      ui.timer.hidden = true;
      ui.timer.textContent = '';
    }
  }
  panel.dataset.phase = localError ? 'error' : recording ? 'listening' : typingOpen || needsExplicitStart ? 'ready' : host.phase;
  // Motion keyed to what is actually happening (real capture / real work), not to a guess.
  panel.dataset.activity = localError || host.phase === 'error' ? 'error' : panelActivity(host.phase, captureActive);
  const state = orbState();
  const halo = state === 'rest' ? '0.28' : state === 'burst' ? '0.85' : '0.58';
  if (panel.dataset.halo !== halo) {
    panel.dataset.halo = halo;
    panel.style.setProperty('--voice-halo', halo);
  }
  syncOrb();
  let label = '开始说话';
  if (recording) label = captureActive ? '停止提交' : '停止';
  else if (speech) label = '跳过朗读';
  else if (host.phase === 'preparing') label = '准备中';
  else if (submission || ['transcribing', 'working'].includes(host.phase)) label = '处理中';
  else if (host.canPrepare && host.phase !== 'question') label = '准备语音';
  else if (localError || localNotice || host.phase === 'error') label = '重试';
  else if (needsExplicitStart && ['ready', 'listening', 'question'].includes(host.phase)) label = '开始说话';
  else if (host.phase === 'question') label = '回答';
  else if (host.phase === 'done') label = '再次说话';
  // The primary control is an icon button; its visible glyph is driven by data-mode and
  // its name stays available to assistive tech.
  ui.primary.setAttribute('aria-label', label);
  ui.primary.title = label;
  ui.primary.dataset.mode = busy ? 'busy' : host.phase === 'question' ? 'answer' : speech ? 'skip' : 'mic';
  ui.primary.disabled = !exists || Boolean(actionPending) || (busy && !recording && !speech);
  ui.cancel.disabled = !exists;
  const cancelLabel = host.phase === 'done' ? '收起' : '取消';
  ui.cancel.setAttribute('aria-label', cancelLabel);
  ui.cancel.title = host.phase === 'done' ? '收起结果（Esc）' : '取消本次任务（Esc）';
  ui.cancel.dataset.mode = host.phase === 'done' ? 'dismiss' : 'cancel';
  // The idle screen invites one sentence; every other title is the Host's own words.
  showText(ui.echo, toldText());
  showText(ui.error, localError || (host.phase === 'error' ? host.message || '任务未完成，请重试。' : ''));
  showText(ui.detail, host.detail);
  renderItems();
  renderThread();
  panel.classList.toggle('is-live', live);
  // In a conversation the last assistant turn already ends the transcript, so the live
  // title line is redundant once the turn settles.
  panel.classList.toggle('is-settled', !recording && !busy && !speech && !submission && (host.phase === 'done' || host.phase === 'ready'));
  ui.progress.hidden = host.phase !== 'preparing';
  if (host.progress === undefined) ui.progress.removeAttribute('value');
  else ui.progress.value = host.progress;
  ui.level.hidden = !captureActive;
  let hint = '快捷键唤起后说话 · Esc 取消';
  if (!hasBridge) hint = '请通过已安装插件启动原生语音组件';
  else if (localNotice) hint = localNotice;
  else if (recording) hint = captureActive ? '停顿约 1.1 秒自动提交 · 最长 20 秒' : '仅本次使用 · 可随时取消';
  else if (speech) hint = '仅使用设备本地语音，朗读结束后再聆听';
  else if (typingOpen) hint = '仅按 Enter 或点击发送才会提交';
  else if (host.canPrepare) hint = '首次使用：点击准备本地识别，不会开启麦克风';
  else if (needsExplicitStart && ['ready', 'listening', 'question'].includes(host.phase)) hint = '点击开始说话继续录音';
  else if (host.phase === 'done') hint = mayDismissFeedback() || mayCollapseThread() ? '本次任务已结束 · 即将收起' : '结果已保留 · 阅读完点击收起';
  ui.hint.textContent = hint;
  ui.hint.title = hint;
  ui['typing-toggle'].disabled = !exists || busy || Boolean(actionPending);
  // The toggle is an icon button now: its name lives in aria-label, never as text.
  const typingLabel = typingOpen ? '收起键盘输入' : '改用键盘输入';
  ui['typing-toggle'].setAttribute('aria-label', typingLabel);
  ui['typing-toggle'].title = typingLabel;
  ui['typing-toggle'].setAttribute('aria-expanded', String(typingOpen));
  ui['text-form'].hidden = !typingOpen;
  ui['text-input'].disabled = busy || !exists;
  ui['text-submit'].disabled = busy || !exists || !ui['text-input'].value.trim();
}

// Focus/selection/scroll are reading intent, not microphone or submission gestures.
ui.detail.tabIndex = 0;
for (const node of [ui.echo, ui.detail]) {
  node.addEventListener('focusin', retainFeedbackForReading);
  node.addEventListener('pointerdown', retainFeedbackForReading);
  node.addEventListener('wheel', retainFeedbackForReading, { passive: true });
}
document.addEventListener('scroll', retainFeedbackForReading, { capture: true, passive: true });
document.addEventListener('selectionchange', () => { if (readingFeedback() || threadReading()) retainFeedbackForReading(); });

ui.thread.addEventListener('scroll', () => { syncOverflow(); }, { passive: true });
for (const type of ['wheel', 'pointerdown', 'touchstart']) ui.thread.addEventListener(type, () => { readerScrolled = true; }, { passive: true });
window.addEventListener('resize', () => {
  // The helper changes the frame size after a turn; keep the newest line in view unless the
  // reader deliberately scrolled back through the transcript.
  if (!readerScrolled && panel.classList.contains('is-thread')) ui.thread.scrollTop = ui.thread.scrollHeight;
  syncOverflow();
});
ui.more.addEventListener('click', () => {
  const direction = ui.more.dataset.edge === 'top' ? -1 : 1;
  ui.thread.scrollBy({ top: direction * Math.max(80, ui.thread.clientHeight * 0.8), behavior: 'smooth' });
});

ui.primary.addEventListener('click', () => {
  if (ui.primary.disabled) return;
  if (attempt) { attempt.recorder.finish('manual'); return; }
  if (speech) {
    const key = speech.key;
    stopSpeech();
    resolvedQuestion = key;
    speechTailTimer = window.setTimeout(() => { speechTailTimer = undefined; reconcile(); }, 200);
    render();
    return;
  }
  requestAction(host.canPrepare && host.phase !== 'question' ? 'prepare' : 'retry');
});
ui.cancel.addEventListener('click', () => requestAction(host.phase === 'done' ? 'dismiss' : 'cancel'));
ui['typing-toggle'].addEventListener('click', () => {
  if (ui['typing-toggle'].disabled) return;
  typingOpen = !typingOpen;
  if (typingOpen) {
    feedbackRetention = updateFeedbackRetention(feedbackRetention, host, true);
    consumedIntent = listenIntent;
    stopCapture();
    stopSpeech();
    clearDoneTimer();
  }
  render();
  if (typingOpen) ui['text-input'].focus();
});
ui['text-input'].addEventListener('input', () => {
  if (uncertainText && uncertainText.text !== ui['text-input'].value.trim()) uncertainText = undefined;
  render(); // Never submit a draft, change event, or recovered text automatically.
});
ui['text-form'].addEventListener('submit', event => {
  event.preventDefault();
  const text = ui['text-input'].value.trim();
  if (disposed || !typingOpen || ui['text-submit'].disabled || !text || text.length > 2000) return;
  stopCapture();
  stopSpeech();
  clearDoneTimer();
  userBlocked = true;
  consumedIntent = listenIntent;
  localError = localNotice = '';
  try {
    const payload = uncertainText && uncertainText.activationId === host.activationId && uncertainText.text === text
      ? uncertainText : { activationId: host.activationId, utteranceId: window.crypto.randomUUID(), text };
    const token = { ...payload, kind: 'text' };
    submission = token;
    beginOperationTimeout(token.activationId);
    render();
    Promise.resolve(bridge.text(payload)).then(() => {
      if (disposed || submission !== token || host.activationId !== token.activationId) return;
      uncertainText = undefined;
      ui['text-input'].value = '';
      // Keyboard fallback never silently reopens the microphone for a follow-up.
      // A subsequent explicit record/retry creates a fresh native armed activation.
      render();
    }).catch(() => {
      if (submission !== token || host.activationId !== token.activationId) return;
      uncertainText = payload; // An explicit retry of this exact draft reuses its dedupe ID.
      markSendFailure(token, '文字发送失败。内容已保留，请按 Enter 或点击发送重试。');
    });
  } catch {
    submission = undefined;
    clearOperationTimer();
    localError = '无法提交文字，请重试。';
    render();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing && host.activationId) {
    event.preventDefault();
    requestAction(host.phase === 'done' ? 'dismiss' : 'cancel');
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopAll();
    userBlocked = true;
    consumedIntent = listenIntent;
  }
  render();
  reconcile();
});

function dispose() {
  if (disposed) return;
  stopAll();
  disposed = true;
  try { unsubscribe?.(); } catch { /* Native also tears down on renderer/window loss. */ }
}
window.addEventListener('pagehide', dispose, { once: true });
window.addEventListener('beforeunload', dispose, { once: true });
readOrbPalette();
reducedMotion?.addEventListener?.('change', () => { syncOrb(); render(); });
syncOrb();
render();
if (hasBridge) {
  let receivedEvent = false;
  try {
    unsubscribe = bridge.onState(state => { receivedEvent = true; applyState(state); });
    Promise.resolve(bridge.ready()).then(state => {
      // A ready() reply must not overwrite a more recent state/activation event.
      if (!receivedEvent) applyState(state);
    }).catch(() => {
      if (disposed || receivedEvent) return;
      localError = '原生语音组件未就绪，请重新唤起。';
      render();
    });
  } catch {
    localError = '原生语音组件连接失败，请重新唤起。';
    render();
  }
}
