import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PHASE_LABELS, SHORT_FEEDBACK_MAX_CHARACTERS, SHORT_FEEDBACK_DISMISS_MS, THREAD_FEEDBACK_DISMISS_MS,
  selectPanelStatus, selectPanelEcho, feedbackKey, updateFeedbackRetention, shouldAutoDismissFeedback, shouldDismissThread,
  PANEL_SIZES, panelActivity, shouldAutoPrepare,
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

test('a clean, fully visible conversation closes itself after the longer thread budget', () => {
  assert.equal(THREAD_FEEDBACK_DISMISS_MS, 7000);
  assert.equal(shouldDismissThread(done), true);
  // Nothing to clarify, no failure: a shorter or longer answer does not change the rule.
  assert.equal(shouldDismissThread({ ...done, message: '文'.repeat(400) }), true);
  assert.equal(shouldDismissThread({ ...done, detail: '补充说明' }), true);
});

test('a conversation stays while anything is clipped, being read, typed into or broken', () => {
  for (const options of [
    { overflow: true }, { retained: true }, { reading: true }, { keyboardOpen: true },
    { hasError: true }, { hasNotice: true }, { pageVisible: false },
  ]) assert.equal(shouldDismissThread(done, options), false, JSON.stringify(options));
  // Questions and failures are never a clean finish, whatever the viewport says.
  assert.equal(shouldDismissThread({ ...done, phase: 'question' }), false);
  assert.equal(shouldDismissThread({ ...done, phase: 'error' }), false);
  assert.equal(shouldDismissThread({ ...done, visible: false }), false);
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

test('every phase shares one frame and reports its activity state', () => {
  assert.deepEqual(PANEL_SIZES, { voice: { width: 620, height: 268 } });
  assert.equal(panelActivity('listening', true), 'listening');
  assert.equal(panelActivity('working'), 'working');
  assert.equal(panelActivity('transcribing'), 'working');
  assert.equal(panelActivity('question'), 'waiting');
  assert.equal(panelActivity('done'), 'done');
  assert.equal(panelActivity('error'), 'error');
  assert.equal(panelActivity('ready'), 'idle');
});

test('the native window creates exactly the frame the page expects', async () => {
  const source = await readFile(new URL('../native/main.mjs', import.meta.url), 'utf8');
  for (const [name, size] of Object.entries(PANEL_SIZES)) {
    const expected = `PANEL_${name.toUpperCase()} = Object.freeze({ width: ${size.width}, height: ${size.height} })`;
    assert.ok(source.includes(expected), expected);
  }
  // Receiving, thinking and the conversation are one card: no per-phase size ladder.
  assert.doesNotMatch(source, /PANEL_(?:COMPACT|FULL|THREAD)|conversationSize/u);
});

test('a voice gesture prepares itself once per activation instead of asking for a click', () => {
  assert.equal(shouldAutoPrepare({ phase: 'preparing', canPrepare: true, captureIntent: true, activationId: 'a' }), true);
  assert.equal(shouldAutoPrepare({ phase: 'preparing', canPrepare: true, captureIntent: true, activationId: 'a', prepared: 'a' }), false);
  assert.equal(shouldAutoPrepare({ phase: 'preparing', canPrepare: true, captureIntent: false, activationId: 'a' }), false);
  assert.equal(shouldAutoPrepare({ phase: 'working', canPrepare: true, captureIntent: true, activationId: 'a' }), false);
  assert.equal(shouldAutoPrepare({ phase: 'ready', canPrepare: false, captureIntent: true, activationId: 'a' }), false);
});

test('the transcript projection bounds roles, text and rows; the overflow label is honest', async () => {
  const { selectPanelThread, threadOverflow, MAX_THREAD_TURNS, THREAD_TEXT_MAX } = await import('../voice-ui/view-state.js');
  const turns = [
    { role: 'user', text: '帮我找环润讯的推文' },
    { role: 'assistant', text: '找到 2 条', items: [{ name: 'e-bot-panel', type: 'HTML', folder: '/a/ui-concepts/archive', copy: '/a/ui-concepts/archive/e-bot-panel.html', copyKind: 'path' }] },
    { role: 'system', text: 'ignored' },
    { role: 'user', text: '   ' },
    { role: 'assistant', text: 'x'.repeat(THREAD_TEXT_MAX + 50) },
  ];
  const projected = selectPanelThread({ turns });
  assert.equal(projected.length, 3);
  assert.deepEqual(projected.map(turn => turn.role), ['user', 'assistant', 'assistant']);
  assert.equal(projected[1].items[0].folderLabel, 'ui-concepts/archive');
  assert.equal(projected[1].items[0].copyKind, 'path');
  assert.equal(projected[2].text.length, THREAD_TEXT_MAX);
  // Nine turns keep the newest eight.
  const many = Array.from({ length: 12 }, (_, index) => ({ role: 'user', text: `第 ${index} 句` }));
  const kept = selectPanelThread({ turns: many });
  assert.equal(kept.length, MAX_THREAD_TURNS);
  assert.equal(kept.at(-1).text, '第 11 句');
  // A user turn never carries rows, even if the Host sent them.
  assert.equal(selectPanelThread({ turns: [{ role: 'user', text: 'x', items: [{ name: 'a' }] }] })[0].items, undefined);

  assert.deepEqual(threadOverflow({ below: 2, above: 1 }), { edge: 'bottom', label: '还没看完 · 还有 2 段' });
  assert.deepEqual(threadOverflow({ above: 3 }), { edge: 'top', label: '上面还有 3 段' });
  assert.deepEqual(threadOverflow({}), { edge: '', label: '' });
});
