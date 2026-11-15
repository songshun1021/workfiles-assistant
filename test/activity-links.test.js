import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createObservedLinkOpener } from '../lib/activity-host.js';
import { createOperations } from '../lib/operations.js';
import { ContextSchema, emptyContext, foldContext, findWebCandidate } from '../lib/context.js';
import { createToolDefinitions } from '../lib/tools.js';

// Pure records, real operation composition and normal projection events only.
// Native opening is a spy; no App, URL, profile, browser, AX or model is invoked.
const APP = { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' };
const AT = '2026-11-14T02:00:00.000Z';
const row = (hint = { title: '上午项目方案', url: 'https://example.feishu.cn/docx/approved-document' }) => ({ id: `wa-${randomUUID()}`, kind: 'window', app: APP, observedAt: AT, window: hint });
function fixture(initial = row()) {
  let record = initial, enabled = true;
  let policy = { enabled: true, applications: [APP.id], contextApplications: [APP.id], retentionDays: 7 };
  const calls = { native: [], entries: [], fileChecks: 0 };
  const controller = {
    getSettings: () => structuredClone(policy),
    async entry(id, signal) { signal?.throwIfAborted(); calls.entries.push(id); return record ? structuredClone(record) : null; },
    async list(query, signal) {
      signal?.throwIfAborted();
      let entries = record ? [structuredClone(record)] : [];
      if (query.kind === 'application') entries = entries.map(({ id, app, observedAt }) => ({ id, app, observedAt, kind: 'application' }));
      return { entries, applications: [], retentionDays: 7, matchedCount: entries.length, truncated: false };
    },
    async currentForSession() { return null; },
  };
  const combine = signal => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(2000)]);
  const open = createObservedLinkOpener({ getController: () => controller, readSettings: () => ({ enabled }), combine,
    native: async (argv, options) => { options.signal.throwIfAborted(); calls.native.push({ argv, options }); }, now: () => Date.parse(AT) });
  const states = new Map();
  const state = session => states.get(session) ?? { context: emptyContext(), tools: {}, commands: {} };
  const ops = createOperations({ getActivity: () => controller, getContext: session => state(session).context,
    getSettings: () => ({ enabled, roots: [] }), getTurn: session => state(session).turn ?? 0, openObserved: open,
    engine: { async observedCandidate() { calls.fileChecks++; throw new Error('Window hints must not be statted as files'); } } });
  const A = { session: { id: 'voice-a' } }, B = { session: { id: 'other-b' } };
  async function call(agent, action, args = {}) {
    const callId = randomUUID();
    states.set(agent.session, foldContext(state(agent.session), { type: 'tool/call', data: { name: `workfiles_${action}`, callId } }));
    const result = await ops.run(agent, action, args);
    states.set(agent.session, foldContext(state(agent.session), { type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(result) }] } } }));
    return result;
  }
  return { controller, calls, open, call, A, B, state,
    get record() { return record; }, set record(value) { record = value; },
    get policy() { return policy; }, set policy(value) { policy = value; },
    set searchEnabled(value) { enabled = value; } };
}

test('shared observed opener accepts only the sanitized retained URL and fixed open argv', async () => {
  const h = fixture(), value = await h.open(h.record.id);
  assert.equal(value.status, 'open_requested'); assert.equal(value.requestedAt, AT);
  assert.deepEqual(h.calls.native[0].argv, ['/usr/bin/open', '--', h.record.window.url]);
  assert.equal(h.calls.native[0].options.timeout, 8000); assert.equal(h.calls.native[0].options.maxBytes, 4096);
});

test('observed opener rejects forged IDs and control suffixes before storage or native work', async () => {
  const h = fixture();
  for (const id of ['', 'https://example.com', '/private/file', h.record.id + '\n', h.record.id + '\r', h.record.id + '\u2028', 'wa-' + 'x'.repeat(36)]) {
    await assert.rejects(h.open(id), { code: 'UNKNOWN_CANDIDATE' });
  }
  assert.equal(h.calls.entries.length, 0); assert.equal(h.calls.native.length, 0);
});

for (const url of ['http://example.com/doc', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com/doc', 'https://127.0.0.1/doc', 'https://localhost/doc', 'https://example.com/doc?access_token=secret', 'https://example.com/doc#secret']) {
  test(`stored noncanonical/unsafe URL cannot be opened: ${url.split(':')[0]}`, async () => {
    const h = fixture(row({ title: 'Untrusted record', url }));
    await assert.rejects(h.open(h.record.id), { code: 'STALE_ACTIVITY' }); assert.equal(h.calls.native.length, 0);
  });
}

test('title-only, wrong-id, deleted/expired and wrong-kind rows never become opening authority', async () => {
  const h = fixture(row({ title: 'Title only' })), id = h.record.id;
  await assert.rejects(h.open(id), { code: 'STALE_ACTIVITY' });
  h.record = row(); await assert.rejects(h.open(id), { code: 'STALE_ACTIVITY' });
  h.record = null; await assert.rejects(h.open(id), { code: 'STALE_ACTIVITY' });
  h.record = { ...row(), id, kind: 'application' }; await assert.rejects(h.open(id), { code: 'STALE_ACTIVITY' });
  assert.equal(h.calls.native.length, 0);
});

test('current app/context consent and pause are checked again immediately before opening', async () => {
  const h = fixture(), id = h.record.id;
  h.policy = { ...h.policy, contextApplications: [] };
  await assert.rejects(h.open(id), { code: 'SCOPE_REVOKED' });
  h.policy = { ...h.policy, applications: [], contextApplications: [APP.id] };
  await assert.rejects(h.open(id), { code: 'SCOPE_REVOKED' });
  h.policy = { ...h.policy, applications: [APP.id] }; h.searchEnabled = false;
  await assert.rejects(h.open(id), { code: 'SEARCH_DISABLED' }); assert.equal(h.calls.native.length, 0);
});

test('Session expected URL, app and observation time must still match the retained row', async () => {
  const h = fixture(), expected = { id: h.record.id, url: h.record.window.url, app: APP, observedAt: AT };
  for (const changed of [{ url: 'https://other.example.com/doc' }, { app: { id: 'com.example.Other' } }, { observedAt: '2026-11-14T03:00:00Z' }, { id: `wa-${randomUUID()}` }]) {
    await assert.rejects(h.open(h.record.id, undefined, { ...expected, ...changed }), { code: 'STALE_ACTIVITY' });
  }
  assert.equal(h.calls.native.length, 0);
});

test('already-aborted opening performs no row lookup or OS request', async () => {
  const h = fixture(), abort = new AbortController(); abort.abort(new Error('cancel before lookup'));
  await assert.rejects(h.open(h.record.id, abort.signal), /cancel before lookup/);
  assert.equal(h.calls.entries.length, 0); assert.equal(h.calls.native.length, 0);
});

test('normal history result binds a web candidate only to the Session that queried it', async () => {
  const h = fixture(), result = await h.call(h.A, 'history', { detail: 'documents' });
  assert.equal(result.ok, true); assert.equal(result.data.candidates.length, 0); assert.equal(result.data.webCandidates.length, 1);
  const candidate = result.data.webCandidates[0];
  assert.equal(findWebCandidate(h.state(h.A.session).context, candidate.id).url, candidate.url);
  assert.equal((await h.call(h.B, 'open', { candidateId: candidate.id })).code, 'UNKNOWN_CANDIDATE');
  const opened = await h.call(h.A, 'open', { candidateId: candidate.id });
  assert.equal(opened.ok, true); assert.equal(opened.data.status, 'open_requested'); assert.equal(opened.data.targetType, 'web');
  assert.equal(h.calls.native.length, 1); assert.equal(h.calls.fileChecks, 0);
  assert.equal(h.state(h.A.session).context.lastWebOpened.candidate.id, candidate.id);
});

test('app-only history does not disclose titles/URLs, create link capabilities, or perform file/OS work', async () => {
  const h = fixture(), result = await h.call(h.A, 'history');
  assert.equal(result.ok, true); assert.deepEqual(result.data.webCandidates, []);
  assert.equal(JSON.stringify(result).includes(h.record.window.url), false);
  assert.equal(JSON.stringify(result).includes(h.record.window.title), false);
  assert.equal((await h.call(h.A, 'open', { candidateId: h.record.id })).code, 'UNKNOWN_CANDIDATE');
  assert.equal(h.calls.native.length, 0); assert.equal(h.calls.fileChecks, 0);
});

test('record deletion/revocation after a successful history query blocks the stale same-Session link', async () => {
  const h = fixture(), result = await h.call(h.A, 'history', { detail: 'all' }), id = result.data.webCandidates[0].id;
  h.record = null;
  assert.equal((await h.call(h.A, 'open', { candidateId: id })).code, 'STALE_ACTIVITY');
  assert.equal(h.calls.native.length, 0);
});

test('context clear removes both current and last-opened web candidates, not stored ledger rows', async () => {
  const h = fixture(), result = await h.call(h.A, 'history', { detail: 'documents' }), id = result.data.webCandidates[0].id;
  await h.call(h.A, 'open', { candidateId: id });
  assert.equal((await h.call(h.A, 'context', { action: 'clear' })).ok, true);
  assert.equal((await h.call(h.A, 'open', { candidateId: id })).code, 'UNKNOWN_CANDIDATE');
  assert.equal(h.record.id, id);
});

test('legacy context gains empty optional web fields without losing file context', () => {
  const legacy = emptyContext(); delete legacy.webCandidates; delete legacy.lastWebOpened;
  const parsed = ContextSchema.parse(legacy);
  assert.deepEqual(parsed.webCandidates, []); assert.equal(parsed.lastWebOpened, null);
});

test('five tools stay fixed: only open accepts observed wa ID; inspect never becomes arbitrary web fetch', async () => {
  const tools = createToolDefinitions(async (_exec, action, args) => ({ action, args }));
  assert.equal(tools.length, 5);
  const id = row().id, open = tools.find(tool => tool.name === 'workfiles_open'), inspect = tools.find(tool => tool.name === 'workfiles_inspect');
  assert.equal((await open.execute({ candidateId: id }, {})).action, 'open');
  await assert.rejects(inspect.execute({ candidateId: id }, {}), { code: 'INVALID_ARGS' });
  for (const input of [{ candidateId: 'https://example.com/doc' }, { candidateId: id + '\n' }, { candidateId: id, url: 'https://example.com/doc' }]) await assert.rejects(open.execute(input, {}), { code: 'INVALID_ARGS' });
});
test('revealing a web clue is refused: it has no local folder to show', async () => {
  const h = fixture(), result = await h.call(h.A, 'history', { detail: 'documents' });
  const id = result.data.webCandidates[0].id;
  const revealed = await h.call(h.A, 'open', { candidateId: id, revealInFinder: true });
  assert.equal(revealed.ok, false); assert.equal(revealed.code, 'REVEAL_UNAVAILABLE');
  assert.equal(h.calls.native.length, 0, 'no Finder or browser request is made');
});

test('a new human request invalidates earlier web candidates until history is queried again', async () => {
  const h = fixture();
  const first = await h.call(h.A, 'history', { detail: 'documents' });
  const id = first.data.webCandidates[0].id;
  assert.equal((await h.call(h.A, 'open', { candidateId: id })).data.status, 'open_requested');
  const opened = h.calls.native.length;
  // A new user message starts a new turn: the previous query is now stale.
  h.state(h.A.session);
  const before = h.state(h.A.session);
  h.state(h.A.session).turn = (before.turn ?? 0) + 1;
  const stale = await h.call(h.A, 'open', { candidateId: id });
  assert.equal(stale.ok, false); assert.equal(stale.code, 'STALE_CONTEXT');
  assert.equal(h.calls.native.length, opened, 'a stale id never reaches the OS');
  // Querying again in the new turn restores the capability.
  const second = await h.call(h.A, 'history', { detail: 'documents' });
  assert.equal(second.data.webCandidates[0].id, id);
  assert.equal((await h.call(h.A, 'open', { candidateId: id })).data.status, 'open_requested');
});
