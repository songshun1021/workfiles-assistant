import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_LABELS, SHORT_FEEDBACK_MAX_CHARACTERS, SHORT_FEEDBACK_DISMISS_MS,
  selectPanelStatus, selectPanelEcho, feedbackKey, updateFeedbackRetention, shouldAutoDismissFeedback,
} from '../voice-ui/view-state.js';

const idle = Object.freeze({ hasBridge: true, activationId: 'activation-a', phase: 'listening' });
const done = Object.freeze({ activationId: 'activation-a', visible: true, phase: 'done', message: '已请求打开预算文档。', detail: '' });

test('keyboard mode reports a stopped microphone instead of the stale Host listening label', () => {
  for (const phase of ['ready', 'listening', 'question', 'working', 'done']) {
    assert.equal(selectPanelStatus({ ...idle, phase, keyboardOpen: true }), '键盘输入 · 麦克风已停止');
  }
});

test('a stopped microphone also suppresses stale listening echo without hiding questions/results', () => {
  const message = '我在听，说完就会执行';
  assert.equal(selectPanelEcho({ phase: 'listening', message, captureActive: false }), '');
  assert.equal(selectPanelEcho({ phase: 'listening', message, captureActive: true }), message);
  assert.equal(selectPanelEcho({ phase: 'question', message: '要今年还是去年？' }), '要今年还是去年？');
  assert.equal(selectPanelEcho({ phase: 'ready', message: '没有找到该文件。' }), '没有找到该文件。');
  assert.equal(selectPanelEcho({ phase: 'done', message: done.message }), done.message);
  assert.equal(selectPanelEcho({ phase: 'error', message: '出错了' }), '');
});

test('closing blocked keyboard mode explicitly asks for a new record gesture', () => {
  for (const phase of ['ready', 'listening', 'question']) {
    assert.equal(selectPanelStatus({ ...idle, phase, needsExplicitStart: true }), '点击开始说话继续录音');
  }
  assert.equal(selectPanelStatus({ ...idle, phase: 'done', needsExplicitStart: true }), PHASE_LABELS.done);
});

test('only a real capture fact displays active listening; pending permission is not listening', () => {
  assert.equal(selectPanelStatus({ ...idle, recording: true }), '等待麦克风授权…');
  assert.equal(selectPanelStatus({ ...idle, recording: true, captureActive: true, elapsedMs: 3499 }), '正在聆听 3s');
  assert.equal(selectPanelStatus({ ...idle, captureActive: true, keyboardOpen: true }), '正在聆听 0s', 'inconsistent UI flags must not hide an active capture fact');
  assert.equal(selectPanelStatus({ ...idle, captureActive: true, elapsedMs: NaN }), '正在聆听 0s');
});

test('bridge, errors and non-recording phases retain clear presentation without side effects', () => {
  assert.equal(selectPanelStatus(), '原生语音桥未连接');
  assert.equal(selectPanelStatus({ hasBridge: true }), '按快捷键开始');
  assert.equal(selectPanelStatus({ ...idle, hasError: true }), '需要重试');
  assert.equal(selectPanelStatus({ ...idle, hasNotice: true }), '已暂停');
  assert.equal(selectPanelStatus({ ...idle, speaking: true }), '正在朗读追问…');
  assert.equal(selectPanelStatus({ ...idle, submitting: true }), '正在提交…');
  for (const phase of ['preparing', 'transcribing', 'working', 'error']) {
    assert.equal(selectPanelStatus({ ...idle, phase, needsExplicitStart: true }), PHASE_LABELS[phase]);
  }
});

test('only short one-line successful feedback can keep the existing 2.1-second dismiss policy', () => {
  assert.equal(SHORT_FEEDBACK_DISMISS_MS, 2100);
  assert.equal(shouldAutoDismissFeedback(done), true);
  assert.equal(shouldAutoDismissFeedback({ ...done, message: '文'.repeat(SHORT_FEEDBACK_MAX_CHARACTERS) }), true);
  assert.equal(shouldAutoDismissFeedback({ ...done, message: '文'.repeat(SHORT_FEEDBACK_MAX_CHARACTERS + 1) }), false);
  assert.equal(shouldAutoDismissFeedback({ ...done, message: '📄'.repeat(SHORT_FEEDBACK_MAX_CHARACTERS) }), true, 'length uses Unicode code points, not UTF-16 units');
});

test('long feedback, multiple lines and supplemental detail remain for manual dismissal', () => {
  for (const message of ['结果'.repeat(100), '第一项\n第二项', '第一项\r第二项', '第一项\u2028第二项', '第一项\u2029第二项']) {
    assert.equal(shouldAutoDismissFeedback({ ...done, message }), false);
  }
  assert.equal(shouldAutoDismissFeedback({ ...done, detail: '请核对候选文档的年份与版本。' }), false);
  assert.equal(shouldAutoDismissFeedback({ ...done, message: '  ' }), false);
});

test('reading, scrolling/overflow, typing or an error prevents even a short result from disappearing', () => {
  for (const state of [{ retained: true }, { reading: true }, { overflowing: true }, { keyboardOpen: true }, { hasError: true }, { pageVisible: false }]) {
    assert.equal(shouldAutoDismissFeedback(done, state), false);
  }
});

test('reader retention is sticky across duplicate snapshots and leaving focus', () => {
  const initial = updateFeedbackRetention(undefined, done);
  assert.equal(initial.retained, false);
  for (const intent of ['focus', 'selection', 'scroll']) {
    const reading = updateFeedbackRetention(initial, done, true);
    const unfocused = updateFeedbackRetention(reading, { ...done }, false);
    assert.equal(unfocused.retained, true, `${intent} persists until manual close or a different result`);
    assert.equal(shouldAutoDismissFeedback(done, unfocused), false);
    assert.equal(Object.isFrozen(unfocused), true);
  }
  assert.equal(initial.retained, false, 'previous state is not mutated');
});

test('a different activation/result resets retention unless the new result is still being read', () => {
  const retained = updateFeedbackRetention(undefined, done, true);
  for (const changed of [{ ...done, activationId: 'activation-b' }, { ...done, message: '另一个结果' }, { ...done, detail: '新详情' }]) {
    assert.notEqual(feedbackKey(changed), retained.key);
    assert.equal(updateFeedbackRetention(retained, changed).retained, false);
    assert.equal(updateFeedbackRetention(retained, changed, true).retained, true);
  }
});

test('ready/not-found, error, question, hidden or stale-empty feedback never schedules auto-dismiss', () => {
  for (const phase of ['ready', 'error', 'question', 'listening', 'working', 'preparing']) {
    const state = { ...done, phase };
    assert.equal(shouldAutoDismissFeedback(state), false);
    assert.deepEqual(updateFeedbackRetention(undefined, state, true), { key: '', retained: false });
  }
  assert.equal(shouldAutoDismissFeedback({ ...done, visible: false }), false);
  assert.equal(shouldAutoDismissFeedback({ ...done, activationId: '' }), false);
  assert.equal(feedbackKey(undefined), '');
});

test('presentation helpers do not mutate Host state or grant any microphone/bridge capabilities', () => {
  const source = Object.freeze({ ...done, capture: true, listen: false });
  const before = { ...source };
  selectPanelStatus({ ...idle, keyboardOpen: true });
  updateFeedbackRetention(undefined, source, true);
  shouldAutoDismissFeedback(source, { retained: true });
  assert.deepEqual(source, before);
});
