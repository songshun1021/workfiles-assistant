import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOperations } from '../lib/operations.js';
import { FORMAT, emptyContext, foldContext, findCandidate, contextProjection } from '../lib/context.js';
import { createToolDefinitions, HistoryArguments } from '../lib/tools.js';

// Synthetic application observations and candidate metadata only. No actual
// App, filesystem, profile, microphone or model is accessed.
const WORD = { id: 'com.microsoft.Word', name: 'Microsoft Word' };
const TIME = '2026-11-13T12:00:00Z';
const doc = (name = '课题报告.docx') => ({ path: `/approved/${name}`, name, kind: 'document', modifiedAt: '2026-11-01T00:00:00Z' });
const entry = (document, app = WORD) => ({ id: `wa-${randomUUID()}`, kind: document ? 'document' : 'application', app, observedAt: TIME, ...(document ? { document } : {}) });
const candidate = file => ({ id: `wf-${randomUUID()}`, path: file, name: file.split('/').at(-1), folder: '/approved', root: '/approved', relativePath: file.split('/').at(-1), extension: 'docx', bytes: 10, modifiedAt: TIME,
  _identity: { key: `1:${randomUUID()}`, mtimeMs: Date.parse(TIME), bytes: 10, version: 'fresh' }, contentStatus: 'not_read' });
function fixture(options = {}) {
  const contexts = new Map(), calls = { observed: [], opened: [], queries: [], currents: [], clear: 0 };
  const A = { session: { id: `workfiles-voice-${randomUUID()}` } }, B = { session: { id: 'other-chat' } };
  const get = session => contexts.get(session) ?? { context: emptyContext(), tools: {}, commands: {} };
  const rows = options.entries ?? [entry(doc()), entry()];
  const activity = options.unavailable ? null : {
    getSettings: () => ({ enabled: options.enabled === true, applications: [WORD.id], retentionDays: 7 }),
    async list(query) {
      calls.queries.push(query);
      let entries = rows;
      if (query.kind === 'application') entries = rows.map(({ id, app, observedAt }) => ({ id, app, observedAt, kind: 'application' }));
      if (query.kind === 'document') entries = rows.filter(row => row.document);
      return { entries: structuredClone(entries), retentionDays: 7, applications: [{ app: WORD, lastObservedAt: TIME, observations: rows.length }], matchedCount: entries.length, truncated: false };
    },
    async currentForSession(id, signal, detail) {
      calls.currents.push({ id, detail });
      if (!options.current) return null;
      const current = { ...entry(options.current), temporary: true, source: 'explicit_voice_gesture' };
      if (!detail.documents) { delete current.document; current.kind = 'application'; }
      return current;
    },
  };
  const engine = {
    async status() { return { roots: ['/approved'], configuredRoots: ['/approved'], warnings: [] }; },
    async search() { return { query: 'test', sort: 'modified', candidates: [candidate('/approved/earlier.docx')] }; },
    async observedCandidate(file, signal) { calls.observed.push(file); signal?.throwIfAborted(); if (options.rejectPath === file) throw Object.assign(new Error('scope revoked'), { code: 'OUTSIDE_SCOPE' }); return candidate(file); },
    async open(value) { calls.opened.push(value); return { status: 'open_requested', candidate: value, requestedAt: TIME }; },
  };
  const ops = createOperations({ engine, getContext: session => get(session).context, getSettings: () => ({ enabled: true, roots: ['/approved'] }), getActivity: () => activity });
  const commit = (session, event) => contexts.set(session, foldContext(get(session), event));
  const call = async (agent, action, args = {}) => {
    const id = randomUUID(), tool = `workfiles_${action}`;
    commit(agent.session, { type: 'tool/call', data: { name: tool, callId: id } });
    const value = await ops.run(agent, action, args);
    commit(agent.session, { type: 'tool/result', data: { message: { toolCallId: id, content: [{ type: 'text', text: JSON.stringify(value) }] } } });
    return value;
  };
  return { A, B, ops, call, get, calls, activity };
}

test('history arguments contain only bounded read filters, never paths/tokens/configuration', async () => {
  const names = Object.keys(createToolDefinitions(() => {}) .find(tool => tool.name === 'workfiles_history').parameters.properties);
  assert.deepEqual(names, ['view', 'detail', 'query', 'after', 'before', 'limit']);
  for (const args of [{ token: randomUUID() }, { path: '/private' }, { enabled: true }, { applications: [WORD.id] }, { view: 'enable' }, { limit: 21 }, { after: '2026-11-13T00:00:00' }]) assert.equal(HistoryArguments.safeParse(args).success, false);
  const tool = createToolDefinitions(async (_exec, action, args) => ({ action, args })).find(tool => tool.name === 'workfiles_history');
  assert.deepEqual(await tool.execute({ view: 'current', detail: 'documents' }, {}), { action: 'history', args: { view: 'current', detail: 'documents' } });
});

test('app-only default reveals no document names/paths, does no candidate stat and keeps the prior visible shortlist', async () => {
  const h = fixture(); await h.call(h.A, 'search');
  const previous = h.get(h.A.session).context.candidates[0];
  const result = await h.call(h.A, 'history');
  assert.equal(result.ok, true); assert.equal(result.data.detail, 'applications');
  assert.equal(h.calls.queries[0].kind, 'application'); assert.equal(h.calls.observed.length, 0);
  assert.doesNotMatch(JSON.stringify(result.data.entries), /课题|approved|document/);
  assert.deepEqual(result.data.candidates, []); assert.equal(result.context, undefined);
  assert.equal(h.get(h.A.session).context.candidates[0].id, previous.id);
});

test('document history creates fresh ordinary IDs, commits through the existing projection and opens only in that Session', async () => {
  const h = fixture(), result = await h.call(h.A, 'history', { detail: 'documents' });
  assert.equal(result.format, FORMAT); assert.equal(result.action, 'history');
  const selected = result.data.candidates[0]; assert.equal(selected.path, '/approved/课题报告.docx');
  assert.equal(h.calls.opened.length, 0); assert.equal(selected._identity.version, 'fresh');
  assert.equal(findCandidate(h.get(h.A.session).context, selected.id).id, selected.id);
  assert.equal((await h.call(h.B, 'open', { candidateId: selected.id })).code, 'UNKNOWN_CANDIDATE');
  assert.equal((await h.call(h.A, 'open', { candidateId: selected.id })).data.status, 'open_requested');
  assert.equal(h.calls.opened.length, 1); assert.equal(contextProjection().stateVersion, 3);
});

test('application-only rows never invent a file from the app name', async () => {
  const h = fixture({ entries: [entry()] });
  const result = await h.call(h.A, 'history', { detail: 'all' });
  assert.deepEqual(result.data.candidates, []); assert.equal(h.calls.observed.length, 0);
});

test('current cue is queried for the actual Session and delivered only by an ordinary history tool result', async () => {
  const h = fixture({ current: doc() });
  const result = await h.call(h.A, 'history', { view: 'current', detail: 'documents' });
  assert.equal(h.calls.currents[0].id, h.A.session.id); assert.equal(h.calls.queries.length, 0);
  assert.equal(result.data.current.temporary, true); assert.equal(result.data.current.source, 'explicit_voice_gesture');
  assert.equal(result.data.candidates.length, 1); assert.equal(h.get(h.A.session).context.candidates.length, 1);
});

test('current app view requests no document validation and discloses no document fields', async () => {
  const h = fixture({ current: doc() });
  const result = await h.call(h.A, 'history', { view: 'current' });
  assert.equal(h.calls.currents[0].detail.documents, false); assert.equal(h.calls.observed.length, 0);
  assert.equal(result.data.current.document, undefined); assert.equal(result.data.current.kind, 'application');
});

test('same document in recent and current becomes one fresh candidate, not two opens', async () => {
  const value = doc(), h = fixture({ entries: [entry(value), entry(value)], current: value });
  const result = await h.call(h.A, 'history', { view: 'both', detail: 'documents' });
  assert.equal(result.data.candidates.length, 1); assert.equal(h.calls.observed.length, 1); assert.equal(h.calls.opened.length, 0);
});

test('candidate shortlist stays bounded when twenty historical documents plus a current cue are available', async () => {
  const h = fixture({ entries: Array.from({ length: 20 }, (_, i) => entry(doc(`report-${i}.docx`))), current: doc('current.docx') });
  const result = await h.call(h.A, 'history', { view: 'both', detail: 'documents', limit: 20 });
  assert.equal(result.data.candidates.length, 20); assert.equal(result.data.candidates[0].name, 'current.docx');
  assert.equal(h.get(h.A.session).context.candidates.length, 20);
});

test('deletion or scope loss between ledger query and candidate validation cannot grant an open ID', async () => {
  const h = fixture({ entries: [entry(doc())], rejectPath: '/approved/课题报告.docx' });
  const result = await h.call(h.A, 'history', { detail: 'documents' });
  assert.deepEqual(result.data.candidates, []); assert.equal(result.context, undefined); assert.equal(h.calls.opened.length, 0);
});

for (const args of [
  { before: '2026-11-12T00:00:00Z' }, { after: '2026-11-14T00:00:00Z' }, { query: '完全不同的课题' },
]) test(`current cue obeys time/topic filters ${JSON.stringify(args)}`, async () => {
  const h = fixture({ current: doc() });
  const result = await h.call(h.A, 'history', { view: 'current', detail: 'documents', ...args });
  assert.equal(result.data.current, null); assert.deepEqual(result.data.candidates, []);
});

test('unavailable ledger does not remove file search and cannot pretend to have OS/browser history', async () => {
  const h = fixture({ unavailable: true });
  const result = await h.call(h.A, 'history'); assert.equal(result.code, 'ACTIVITY_UNAVAILABLE');
  assert.equal((await h.call(h.A, 'search')).ok, true);
});

test('history coverage distinguishes consent, retention, snapshots and modification time, without backfill', async () => {
  const h = fixture(); const result = await h.call(h.A, 'history');
  assert.equal(result.data.recordingEnabled, false); assert.equal(result.data.coverage.backfill, false);
  assert.equal(result.data.coverage.browserHistory, false); assert.equal(result.data.coverage.maximumDays, 7);
  assert.match(result.data.note, /不证明阅读、编辑、保存/); assert.match(result.data.note, /modifiedAt/);
});

test('invalid history view/detail cannot mutate the existing candidate context', async () => {
  const h = fixture(); await h.call(h.A, 'search'); const id = h.get(h.A.session).context.candidates[0].id;
  for (const args of [{ view: 'enable' }, { detail: 'full_screen' }]) assert.equal((await h.call(h.A, 'history', args)).code, 'INVALID_HISTORY');
  assert.equal(h.get(h.A.session).context.candidates[0].id, id);
});

test('derived-context clear is not ledger erasure and no history argument can enable recording', async () => {
  const h = fixture(); await h.call(h.A, 'history', { detail: 'documents' });
  await h.call(h.A, 'context', { action: 'clear' });
  assert.equal(h.get(h.A.session).context.candidates.length, 0); assert.equal(h.calls.clear, 0);
  assert.equal(h.activity.getSettings().enabled, false);
});

test('successful folder revocation waits for persistent metadata cleanup, not merely a filtered UI', async () => {
  let settings = { roots: ['/approved'], enabled: true }, resolve, fences = 0, done = false;
  const cleanup = new Promise(yes => { resolve = yes; });
  const ops = createOperations({ engine: {}, getContext: () => emptyContext(), getSettings: () => settings,
    saveSettings: async change => { settings = { ...settings, ...change(settings) }; }, onScopeChange: () => { fences++; if (fences === 2) return cleanup; } });
  const request = ops.configure({ action: 'remove_root', path: '/approved' }).then(value => { done = true; return value; });
  await new Promise(yes => setImmediate(yes)); assert.deepEqual(settings.roots, []); assert.equal(done, false);
  resolve(); assert.equal((await request).ok, true); assert.equal(fences, 2);
});
