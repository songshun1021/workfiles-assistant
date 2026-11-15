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
/** Rows the panel may show next to the spoken answer. Only successful results and
 * questions show them, at most `max` rows; the folder is shortened to its last two
 * segments and the timestamp stays an opaque string for the page to localise. */
export function selectPanelItems({ phase = 'done', items = [], max = 3 } = {}) {
  if (phase !== 'done' && phase !== 'question') return [];
  const rows = Array.isArray(items) ? items : [];
  return rows.filter(item => item && typeof item.name === 'string' && item.name.trim()).slice(0, Math.max(0, max)).map(item => {
    const segments = typeof item.folder === 'string' ? item.folder.split('/').filter(Boolean) : [];
    return {
      name: item.name.slice(0, 140),
      folderLabel: segments.slice(-2).join('/'),
      modifiedAt: typeof item.modifiedAt === 'string' ? item.modifiedAt.slice(0, 64) : '',
      type: typeof item.type === 'string' ? item.type.slice(0, 8) : '',
      copy: typeof item.copy === 'string' ? item.copy.slice(0, 4096).trim() : '',
      copyKind: item.copyKind === 'link' || item.copyKind === 'path' ? item.copyKind : '',
    };
  });
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
