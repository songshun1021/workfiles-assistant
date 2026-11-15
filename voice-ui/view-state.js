// Pure presentation policy only. No DOM, permissions, media APIs or bridge effects.
export const PHASE_LABELS = Object.freeze({
  ready: '准备就绪', preparing: '准备本地语音…', listening: '正在连接麦克风…', transcribing: '正在识别…',
  working: '正在处理…', question: '请回答', done: '已完成', error: '需要重试',
});
export const SHORT_FEEDBACK_MAX_CHARACTERS = 28;
export const SHORT_FEEDBACK_DISMISS_MS = 2100;

export function selectPanelStatus({
  hasBridge = false, activationId = '', phase = 'ready', keyboardOpen = false,
  captureActive = false, recording = false, elapsedMs = 0, speaking = false,
  submitting = false, hasError = false, hasNotice = false, needsExplicitStart = false,
} = {}) {
  if (!hasBridge) return '原生语音桥未连接';
  if (!activationId) return '按快捷键开始';
  // Prefer an actual active capture fact even if a caller supplies inconsistent UI flags.
  if (captureActive) return `正在聆听 ${Math.floor(Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000)}s`;
  if (keyboardOpen) return '键盘输入 · 麦克风已停止';
  if (hasError) return '需要重试';
  if (hasNotice) return '已暂停';
  if (speaking) return '正在朗读追问…';
  if (recording) return '等待麦克风授权…';
  if (submitting) return '正在提交…';
  if (needsExplicitStart && ['ready', 'listening', 'question'].includes(phase)) return '点击开始说话继续录音';
  return PHASE_LABELS[phase] || PHASE_LABELS.ready;
}

export function selectPanelEcho({ phase, message, captureActive = false } = {}) {
  // Listening instructions become stale as soon as input stops; questions/results do not.
  if (phase === 'error' || (phase === 'listening' && !captureActive)) return '';
  return typeof message === 'string' && message !== PHASE_LABELS[phase] ? message : '';
}

export function feedbackKey(state) {
  if (!state?.activationId || state.phase !== 'done' || state.visible === false) return '';
  return JSON.stringify([state.activationId, state.message || '', state.detail || '']);
}

// Reading is sticky for this exact result: leaving focus or another duplicate snapshot
// must not restart a countdown under the reader. A different result starts a new policy.
export function updateFeedbackRetention(previous, state, reading = false) {
  const key = feedbackKey(state);
  return Object.freeze({ key, retained: Boolean(key && (reading || (previous?.key === key && previous.retained))) });
}

// A finished conversation is bigger than a one-line toast, so it gets a longer budget than
// the 2.1s a bare "已打开" used to get. Long enough to read three rows, short enough that a
// clean answer does not leave a card parked on the desktop.
export const THREAD_FEEDBACK_DISMISS_MS = 7000;

/** A finished conversation may close itself only when there is nothing left to do with it:
 * it is done, visible, nothing is clipped out of view, nobody scrolled/selected/focused it,
 * and it is not the keyboard or a failure. The caller owns the "is this a transcript" fact;
 * this rule stays pure and testable. */
export function shouldDismissThread(state, {
  overflow = false, retained = false, reading = false, keyboardOpen = false,
  hasError = false, hasNotice = false, pageVisible = true,
} = {}) {
  if (!feedbackKey(state) || !pageVisible || overflow || retained || reading || keyboardOpen) return false;
  return !hasError && !hasNotice;
}

export function shouldAutoDismissFeedback(state, {
  retained = false, reading = false, overflowing = false, keyboardOpen = false,
  hasError = false, pageVisible = true,
} = {}) {
  if (!feedbackKey(state) || !pageVisible || retained || reading || overflowing || keyboardOpen || hasError) return false;
  const message = typeof state.message === 'string' ? state.message.trim() : '';
  if (!message || String(state.detail || '').trim()) return false;
  if (/[\r\n\u2028\u2029]/u.test(message)) return false;
  return Array.from(message).length <= SHORT_FEEDBACK_MAX_CHARACTERS;
}

// Window density policy: while a task is actually running the panel shrinks so the
// user focuses on progress instead of on the full form. Pure mapping, no DOM.
export const PANEL_SIZES = Object.freeze({ full: Object.freeze({ width: 620, height: 200 }), compact: Object.freeze({ width: 460, height: 124 }) });
export function panelDensity(phase) {
  // Compact for the whole stretch where the panel is doing the talking (and listening);
  // full only when there is something to read or decide. That keeps one shrink and one
  // grow per task instead of a window that bounces between sizes.
  return ['preparing', 'listening', 'transcribing', 'working'].includes(phase) ? 'compact' : 'full';
}
/** The one row shape the panel renders, shared by the current result and the transcript. */
export function panelRow(item) {
  if (!item || typeof item.name !== 'string' || !item.name.trim()) return null;
  const segments = typeof item.folder === 'string' ? item.folder.split('/').filter(Boolean) : [];
  return {
    name: item.name.slice(0, 140),
    folderLabel: segments.slice(-2).join('/'),
    modifiedAt: typeof item.modifiedAt === 'string' ? item.modifiedAt.slice(0, 64) : '',
    type: typeof item.type === 'string' ? item.type.slice(0, 8) : '',
    copy: typeof item.copy === 'string' ? item.copy.slice(0, 4096).trim() : '',
    copyKind: item.copyKind === 'link' || item.copyKind === 'path' ? item.copyKind : '',
  };
}

/** One bounded transcript for the panel: user text, then the assistant's reply and its rows.
 * Anything outside those roles, over the cap, or empty is dropped rather than rendered. */
export const MAX_THREAD_TURNS = 8;
export const THREAD_TEXT_MAX = 600;
export function selectPanelThread({ turns = [], max = MAX_THREAD_TURNS, rowMax = 5 } = {}) {
  return (Array.isArray(turns) ? turns : []).slice(-Math.max(0, max)).flatMap(turn => {
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) return [];
    const text = typeof turn.text === 'string' ? turn.text.trim().slice(0, THREAD_TEXT_MAX) : '';
    if (!text) return [];
    const items = turn.role === 'assistant' && Array.isArray(turn.items)
      ? turn.items.slice(0, rowMax).map(panelRow).filter(Boolean) : [];
    return [{ role: turn.role, text, ...(items.length ? { items } : {}) }];
  });
}

/** Which clipped edge has content behind it, and how to say it. Pure so the rule can be
 * tested without a browser: below wins (reading is downward), history is the fallback. */
export function threadOverflow({ above = 0, below = 0 } = {}) {
  if (below > 0) return { edge: 'bottom', label: `还没看完 · 还有 ${below} 段` };
  if (above > 0) return { edge: 'top', label: `上面还有 ${above} 段` };
  return { edge: '', label: '' };
}

/** Rows the panel may show next to the spoken answer. Only successful results and
 * questions show them, at most `max` rows; the folder is shortened to its last two
 * segments and the timestamp stays an opaque string for the page to localise. */
export function selectPanelItems({ phase = 'done', items = [], max = 3 } = {}) {
  if (phase !== 'done' && phase !== 'question') return [];
  const rows = Array.isArray(items) ? items : [];
  return rows.map(panelRow).filter(Boolean).slice(0, Math.max(0, max));
}

// Busy phases pulse a subtle indicator; reduced-motion users still get the text state.
export function panelActivity(phase = 'ready', captureActive = false) {
  if (captureActive) return 'listening';
  if (['preparing', 'transcribing', 'working'].includes(phase)) return 'working';
  if (phase === 'question') return 'waiting';
  if (phase === 'done') return 'done';
  if (phase === 'error') return 'error';
  return 'idle';
}

// A shortcut-opened panel should not stall on a "prepare" button: when the Host says
// preparation is possible and the gesture asked for voice, prepare once per activation.
export function shouldAutoPrepare({ phase = 'ready', canPrepare = false, captureIntent = false, activationId = '', prepared = '' } = {}) {
  if (!captureIntent || !canPrepare || !activationId || activationId === prepared) return false;
  return ['ready', 'preparing', 'listening'].includes(phase);
}
