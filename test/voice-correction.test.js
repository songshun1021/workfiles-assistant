import test from 'node:test';
import assert from 'node:assert/strict';
import { CORRECTION_SYSTEM, correctTranscript, sanitizeCorrection } from '../lib/voice-correction.js';

test('a repair keeps the same request', () => {
  assert.equal(sanitizeCorrection('帮我找一下上周给华为做的那版报价方案', '帮我找一下上周给华润做的那版报价方案'), '帮我找一下上周给华润做的那版报价方案');
  assert.equal(sanitizeCorrection('帮我找一下 那个 那个 报价方案', '帮我找一下那个报价方案'), '帮我找一下那个报价方案');
});

test('quotes, fences and padding are stripped, not treated as content', () => {
  assert.equal(sanitizeCorrection('打开上个月的报表', '“打开上个月的报表”'), '打开上个月的报表');
  assert.equal(sanitizeCorrection('打开上个月的报表', '```\n打开上个月的报表\n```'), '打开上个月的报表');
  assert.equal(sanitizeCorrection('打开上个月的报表', '  打开上个月的报表。 '), '打开上个月的报表。');
});

test('a rewrite is rejected: the raw transcript stays the floor', () => {
  const raw = '把那个东西弄一下';
  assert.equal(sanitizeCorrection(raw, '好的，我来帮你处理这个问题。首先我们需要确认目标文件的路径和版本信息，然后再决定如何处理。'), raw);
  assert.equal(sanitizeCorrection(raw, ''), raw);
  assert.equal(sanitizeCorrection(raw, '嗯'), raw);
  assert.equal(sanitizeCorrection(raw, 'x'.repeat(2001)), raw);
});

test('a missing route or a failed call never blocks the task', async () => {
  assert.equal(await correctTranscript({ llm: undefined, raw: '找一下报价单' }), '找一下报价单');
  const failing = { stream() { throw new Error('no credits'); } };
  assert.equal(await correctTranscript({ llm: failing, raw: '找一下报价单' }), '找一下报价单');
  const broken = { async *stream() { yield { type: 'text-delta', text: '找' }; throw new Error('network'); } };
  assert.equal(await correctTranscript({ llm: broken, raw: '找一下报价单' }), '找一下报价单');
});

test('the call uses the non-thinking flash route and only the transcript as input', async () => {
  const seen = [];
  const llm = {
    async *stream(options) {
      seen.push(options);
      yield { type: 'text-delta', text: '帮我找' };
      yield { type: 'text-delta', text: '上周的报价方案' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const out = await correctTranscript({ llm, raw: '帮我找上周内个报价方案' });
  assert.equal(out, '帮我找上周的报价方案');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reasoningEffort, 'off');
  assert.equal(seen[0].provider, 'deepseek-account');
  assert.equal(seen[0].model, 'deepseek-flash');
  assert.equal(seen[0].system, CORRECTION_SYSTEM);
  assert.deepEqual(seen[0].messages, [{ role: 'user', content: [{ type: 'text', text: '帮我找上周内个报价方案' }] }]);
});

test('an aborted correction returns the raw text', async () => {
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: '帮我' };
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } };
    },
  };
  assert.equal(await correctTranscript({ llm, raw: '帮我找上周的报价方案' }), '帮我找上周的报价方案');
});
