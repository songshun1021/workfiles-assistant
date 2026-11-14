import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createActivityController } from '../lib/activity-controller.js';
import { APPLICATIONS, ActivitySettingsSchema } from '../lib/activity-ledger.js';

// Entirely synthetic. No OS process, AX attribute, microphone, real file or Agent.
const WORD = APPLICATIONS[0].id, PPT = APPLICATIONS[1].id, EDGE = 'com.microsoft.edgemac', FEISHU = 'com.electron.lark';
const START = Date.parse('2026-11-13T12:00:00Z');
const sessionId = () => `workfiles-voice-${randomUUID()}`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve)); };
const metadata = file => ({ path: file, name: file.split('/').at(-1), kind: 'document', modifiedAt: '2026-11-01T00:00:00Z' });
function fixture(t, options = {}) {
  let clock = START, settings = { enabled: false, applications: [], retentionDays: 7, contextApplications: [], ...options.settings };
  const timers = new Map(), calls = { samples: [], facts: 0, scopes: 0, discoveries: [], entries: [], validated: [], ingested: [], purges: 0, clears: 0, disposed: 0 };
  const hooks = {};
  const ledger = {
    getSettings: () => structuredClone(settings),
    async configure(change, signal) {
      await hooks.configure?.(change); signal.throwIfAborted();
      const next = { ...settings, ...structuredClone(change) };
      if (change.contextApplications === undefined) next.contextApplications = settings.contextApplications.filter(id => next.applications.includes(id));
      settings = ActivitySettingsSchema.parse(next); return this.getSettings();
    },
    async ingest(value, signal) { signal.throwIfAborted(); calls.ingested.push(value); return { recorded: true }; },
    async purge(signal) { calls.purges++; signal.throwIfAborted(); await hooks.purge?.(); return { removed: 0 }; },
    async stats() { return { count: 0, lastObservedAt: null, retentionDays: 7 }; },
    async list(args, signal) { calls.list = args; signal.throwIfAborted(); return { entries: [], retentionDays: 7 }; },
    async clear(signal) { calls.clears++; signal.throwIfAborted(); return { cleared: 0 }; },
    async entry(id, signal) { calls.entries.push({ id, signal }); signal.throwIfAborted(); return hooks.entry ? hooks.entry(id, signal) : null; },
  };
  const source = {
    async sample(request) { calls.samples.push(request); return hooks.sample ? hooks.sample(request) : { app: { id: WORD, name: 'UNTRUSTED APP', pid: 9 }, document: { path: '/approved/report.docx', title: 'UNTRUSTED TITLE' }, observedAt: '1999-01-01T00:00:00Z' }; },
    async status() { calls.facts++; return hooks.status ? hooks.status() : { available: true, accessibilityTrusted: options.trusted === true, applications: APPLICATIONS.map(app => ({ ...app, installed: true })) }; },
    async discoverApplications(request) { calls.discoveries.push(request); return hooks.discover ? hooks.discover(request) : { v: 1, platform: 'darwin', source: 'jxa-applicationservices', applications: [], truncated: false }; },
    async dispose() { calls.disposed++; await hooks.dispose?.(); },
  };
  const controller = createActivityController({ ledger, source, signal: options.signal,
    now: () => clock,
    setTimer(callback, delay) { const id = { unref() {} }; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async getDocumentStatus(signal) { calls.scopes++; signal.throwIfAborted(); return { enabled: options.filesEnabled !== false, roots: options.roots ?? ['/approved'] }; },
    async validateDocument(file, signal) { calls.validated.push(file); signal.throwIfAborted(); return hooks.validate ? hooks.validate(file, signal) : metadata(file); },
  });
  t.after(() => controller.dispose().catch(() => {}));
  const tick = async delay => { const pair = [...timers].find(([, value]) => value.delay === delay); if (!pair) return false; timers.delete(pair[0]); pair[1].callback(); await flush(); return true; };
  return { controller, ledger, source, hooks, calls, timers, tick, advance(ms) { clock += ms; }, async selected(enabled = false) { await controller.configure({ applications: [WORD], enabled }); } };
}

test('construction is passive; disabled start only runs owned local expiry maintenance', async t => {
  const h = fixture(t);
  assert.equal(h.timers.size, 0); assert.equal(h.calls.samples.length, 0); assert.equal(h.calls.facts, 0);
  await h.controller.start(); assert.equal(h.calls.purges, 1);
  assert.equal(await h.tick(0), false);
  assert.equal(await h.tick(60000), true); assert.equal(h.calls.purges, 2);
  assert.equal(h.calls.samples.length, 0); assert.equal(h.calls.scopes, 0); assert.equal(h.calls.facts, 0);
});

test('app selection alone never enables periodic native reads', async t => {
  const h = fixture(t); await h.controller.start();
  await h.controller.configure({ applications: [WORD] });
  assert.equal(h.controller.getSettings().enabled, false);
  assert.equal(await h.tick(0), false); assert.equal(h.calls.samples.length, 0);
  await assert.rejects(h.controller.configure({ enabled: true, applications: [] }), /至少一个/);
});

test('revoking the final app safely pauses in the same configuration without UI enabling authority', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD], contextApplications: [WORD] } });
  await h.controller.start();
  let submitted;
  h.hooks.configure = change => { submitted = structuredClone(change); };
  const result = await h.controller.configure({ applications: [], contextApplications: [] });
  assert.deepEqual(submitted, { applications: [], contextApplications: [], enabled: false });
  assert.deepEqual(result.settings, { enabled: false, applications: [], contextApplications: [], retentionDays: 7 });
  assert.equal(await h.tick(0), false); assert.equal(h.calls.samples.length, 0);
  await assert.rejects(h.controller.configure({ enabled: true }), /至少一个/);
});

test('enabled sampling sends only selected IDs/canonical roots and strips native title/time/pid', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] } });
  await h.controller.start(); await h.tick(0);
  assert.deepEqual(h.calls.samples[0].applications, [WORD]); assert.deepEqual(h.calls.samples[0].roots, ['/approved']);
  assert.deepEqual(h.calls.samples[0].contextApplications, []);
  assert.deepEqual(h.calls.ingested, [{ app: { id: WORD, name: 'UNTRUSTED APP' }, document: { path: '/approved/report.docx' } }]);
  assert.equal(await h.tick(4000), true);
});

test('pausing file search does not silently pause separately authorized metadata recording', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] }, filesEnabled: false });
  await h.controller.start(); await h.tick(0);
  assert.deepEqual(h.calls.samples[0].roots, ['/approved']); assert.equal(h.calls.ingested.length, 1);
});

test('unselected/Edge native responses become null without another app name or title', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] } });
  h.hooks.sample = () => ({ app: { id: 'com.microsoft.edgemac', name: 'PRIVATE EDGE TAB' }, document: { path: '/private/secret.docx' } });
  await h.controller.start(); await h.tick(0);
  assert.deepEqual(h.calls.ingested, [{ app: null }]); assert.equal(h.calls.validated.length, 0);
});

test('status is a cached status-only probe; no AX window snapshot or recording implied', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] } });
  const first = await h.controller.status(); assert.equal(first.state, 'recording_apps');
  await h.controller.status(); assert.equal(h.calls.facts, 1); assert.equal(h.calls.samples.length, 0);
  h.advance(30000); await h.controller.status(); assert.equal(h.calls.facts, 2);
  await h.controller.status(undefined, { refresh: true }); assert.equal(h.calls.facts, 3);
});

test('status reports the latest pause rather than settings captured before its async probe', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] } }), gate = deferred();
  h.hooks.status = () => gate.promise;
  const pending = h.controller.status(); await flush();
  await h.controller.configure({ enabled: false });
  gate.resolve({ available: true, accessibilityTrusted: true, applications: [] });
  assert.equal((await pending).state, 'paused');
});

test('pause synchronously aborts an in-flight native read and drops late output', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] } }), gate = deferred();
  h.hooks.sample = () => gate.promise;
  await h.controller.start(); await h.tick(0); assert.equal(h.calls.samples.length, 1);
  await h.controller.configure({ enabled: false });
  assert.equal(h.calls.samples[0].signal.aborted, true);
  gate.resolve({ app: { id: WORD } }); await flush();
  assert.equal(h.calls.ingested.length, 0); assert.equal(await h.tick(4000), false);
});

test('old aborted poll finally cannot stop a newly resumed collection loop', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] } }), gate = deferred();
  h.hooks.sample = () => gate.promise;
  await h.controller.start(); await h.tick(0);
  await h.controller.configure({ enabled: false }); await h.controller.configure({ enabled: true });
  h.hooks.sample = undefined; gate.resolve({ app: { id: WORD } }); await flush();
  const ran = await h.tick(0) || await h.tick(4000);
  assert.equal(ran, true); assert.equal(h.calls.ingested.length, 1);
});

test('current cue is explicit, temporary, session-bound and never written to the ledger', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected(false);
  const token = await h.controller.captureCurrent(); assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(h.calls.ingested.length, 0);
  const id = sessionId(); assert.equal(h.controller.bindCurrent(token, 'ordinary-chat'), false);
  assert.equal(h.controller.bindCurrent(token, `${id}\n`), false); assert.equal(h.controller.bindCurrent(token, `${id}\u2028`), false);
  assert.equal(h.controller.bindCurrent(token, id), true);
  assert.equal(h.controller.bindCurrent(token, sessionId()), false);
  const value = await h.controller.currentForSession(id);
  assert.equal(value.source, 'explicit_voice_gesture'); assert.equal(value.temporary, true);
  assert.equal(value.document.path, '/approved/report.docx');
  assert.equal(await h.controller.currentForSession(sessionId()), null);
  assert.equal(h.calls.samples.length, 1);
  assert.doesNotMatch(JSON.stringify(await h.controller.status()), new RegExp(token));
});

test('application-only current query omits document fields and performs no metadata validation', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected();
  const token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  h.calls.validated.length = 0;
  const value = await h.controller.currentForSession(id, undefined, { documents: false });
  assert.equal(value.kind, 'application'); assert.equal(value.document, undefined); assert.equal(h.calls.validated.length, 0);
});

test('cue expiry is an owned two-minute timer even while continuous recording is paused', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected();
  const token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  assert.equal(await h.tick(120000), true); assert.equal(await h.controller.currentForSession(id), null);
  assert.equal(h.calls.ingested.length, 0);
});

test('cue access also expires by clock, and a new cue cannot inherit an old Session binding', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected();
  const token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  h.advance(120000); assert.equal(await h.controller.currentForSession(id), null);
  const newer = await h.controller.captureCurrent(); assert.equal(await h.controller.currentForSession(id), null);
  assert.equal(h.controller.bindCurrent(newer, id), true);
});

test('bounded cue cache evicts the oldest token without leaking mappings or timers', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected(); const tokens = [];
  for (let n = 0; n < 17; n++) tokens.push(await h.controller.captureCurrent());
  assert.equal(h.controller.bindCurrent(tokens[0], sessionId()), false);
  assert.equal(h.controller.bindCurrent(tokens.at(-1), sessionId()), true);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 120000).length, 16);
});

for (const action of ['clear', 'scopeChanged', 'revoke']) test(`${action} removes every current capability and expiry timer`, async t => {
  const h = fixture(t); await h.controller.start(); await h.selected();
  const token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  if (action === 'revoke') await h.controller.configure({ applications: [], enabled: false }); else await h.controller[action]();
  assert.equal(await h.controller.currentForSession(id), null);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 120000), false);
});

test('revocation aborts even an explicit current read and cannot mint a late token', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected(); const gate = deferred();
  h.hooks.sample = () => gate.promise;
  const cue = h.controller.captureCurrent(); await flush();
  await h.controller.configure({ enabled: false, applications: [] });
  assert.equal(h.calls.samples[0].signal.aborted, true); assert.equal(await cue, null);
  gate.resolve({ app: { id: WORD } }); await flush();
});

test('pending consent writes fence explicit cues and periodic sampling', async t => {
  const h = fixture(t); await h.controller.start(); const gate = deferred();
  h.hooks.configure = () => gate.promise;
  const changing = h.controller.configure({ applications: [WORD], enabled: true });
  assert.equal(await h.controller.captureCurrent(), null); assert.equal(h.calls.samples.length, 0);
  gate.resolve(); await changing; await h.tick(0); assert.equal(h.calls.samples.length, 1);
});

test('invalid validator metadata and native errors fall back without private paths or exception messages', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected();
  h.hooks.validate = () => ({ ...metadata('/approved/report.docx'), body: 'PRIVATE BODY' });
  const token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  assert.equal((await h.controller.currentForSession(id)).document, undefined);
  h.hooks.sample = () => { throw new Error('PRIVATE NATIVE PATH'); };
  assert.equal(await h.controller.captureCurrent(), null);
});

test('an already aborted caller cannot trigger even the scope callback', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected(); const caller = new AbortController(); caller.abort();
  assert.equal(await h.controller.captureCurrent(caller.signal), null); assert.equal(h.calls.scopes, 0);
});

test('list cancellation while a mutation drains settles without entering the ledger query', async t => {
  const h = fixture(t); await h.controller.start(); const gate = deferred(), caller = new AbortController();
  h.hooks.configure = () => gate.promise;
  const changing = h.controller.configure({ applications: [WORD] });
  const pending = h.controller.list({}, caller.signal); caller.abort(new Error('caller stop'));
  await assert.rejects(pending, /caller stop/); assert.equal(h.calls.list, undefined);
  gate.resolve(); await changing;
});

test('dispose clears all owned timers and joins once; an already aborted owner cannot start', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected(); await h.controller.captureCurrent();
  await h.controller.dispose(); await h.controller.dispose(); assert.equal(h.calls.disposed, 1); assert.equal(h.timers.size, 0);
  const owner = new AbortController(); owner.abort(); const closed = fixture(t, { signal: owner.signal });
  await closed.controller.start(); await closed.controller.dispose();
  assert.equal(closed.calls.samples.length, 0); assert.equal(closed.timers.size, 0); assert.equal(closed.calls.disposed, 1);
});

test('declared source failure does not ingest a false departure, clear deduplication or claim healthy recording', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] } });
  await h.controller.start(); await h.tick(0);
  const previousPoll = (await h.controller.status()).lastPollAt;
  h.hooks.sample = () => ({ app: null, reason: 'SOURCE_UNAVAILABLE' }); h.advance(4000); await h.tick(4000);
  const failed = await h.controller.status();
  assert.equal(h.calls.ingested.length, 1); assert.equal(failed.lastPollAt, previousPoll);
  assert.equal(failed.state, 'unavailable'); assert.ok(failed.lastError);
  h.hooks.sample = () => ({ app: { id: WORD } }); h.advance(4000); await h.tick(4000);
  const recovered = await h.controller.status();
  assert.equal(h.calls.ingested.length, 2); assert.equal(recovered.lastError, null); assert.equal(recovered.state, 'recording_apps');
});

test('a focus race cannot become a departure or a current-document capability', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] } });
  await h.controller.start(); await h.tick(0);
  h.hooks.sample = () => ({ app: { id: WORD }, document: { path: '/approved/report.docx' }, reason: 'FOCUS_CHANGED' });
  await h.tick(4000); assert.equal(h.calls.ingested.length, 1);
  assert.equal(await h.controller.captureCurrent(), null);
  h.hooks.sample = () => ({ app: { id: WORD }, document: { path: '/approved/report.docx' }, reason: 'SOURCE_UNAVAILABLE' });
  assert.equal(await h.controller.captureCurrent(), null);
});

const nativeWindow = (app = EDGE, extra = {}) => ({ v: 1, app: { id: app, name: app === FEISHU ? '  飞书🧭\n\u0085\ud800  ' : 'Microsoft Edge', pid: 123 },
  window: { title: '  Quarterly plan🧭\u0000  ', url: 'HTTPS://EXAMPLE.com/docs/plan?token=PRIVATE#PRIVATE' }, observedAt: '1900-01-01T00:00:00Z', ...extra });
const observedWindow = (extra = {}) => ({ id: `wa-${randomUUID()}`, kind: 'window', app: { id: EDGE, name: 'Microsoft Edge' }, observedAt: new Date(START).toISOString(), window: { title: 'Quarterly plan', url: 'https://example.com/docs/plan' }, ...extra });
const discovery = applications => ({ v: 1, platform: 'darwin', source: 'jxa-applicationservices', applications, truncated: false });

for (const app of [EDGE, FEISHU]) test(`a selected non-seed app ${app} is gated separately from window consent`, async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [app] }, roots: [] });
  h.hooks.sample = () => nativeWindow(app);
  await h.controller.start(); await h.tick(0);
  assert.deepEqual(h.calls.samples[0].applications, [app]); assert.deepEqual(h.calls.samples[0].contextApplications, []); assert.deepEqual(h.calls.samples[0].roots, []);
  assert.deepEqual(h.calls.ingested, [{ app: { id: app, name: app === FEISHU ? '飞书🧭' : 'Microsoft Edge' } }]);
  assert.equal(h.calls.validated.length, 0); assert.doesNotMatch(JSON.stringify(h.calls.ingested), /Quarterly|example\.com|pid|observedAt|PRIVATE/);
  await h.controller.configure({ contextApplications: [app] }); await h.tick(0);
  const sample = h.calls.ingested.at(-1);
  assert.deepEqual(sample.window, { title: 'Quarterly plan🧭', url: 'https://example.com/docs/plan' });
  assert.equal(sample.observedAt, undefined); assert.equal(sample.app.pid, undefined);
  assert.deepEqual(h.calls.samples.at(-1).contextApplications, [app]);
});

test('unselected dynamic responses and unconsented opaque windows cannot leak native metadata', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] }, roots: [] });
  h.hooks.sample = () => nativeWindow(EDGE);
  await h.controller.start(); await h.tick(0);
  assert.deepEqual(h.calls.ingested, [{ app: null }]);
  let reads = 0;
  const opaque = Object.defineProperty({}, 'title', { get() { reads++; throw new Error('PRIVATE'); } });
  h.hooks.sample = () => nativeWindow(WORD, { window: opaque });
  await h.tick(4000);
  assert.deepEqual(h.calls.ingested.at(-1), { app: { id: WORD, name: 'Microsoft Edge' } });
  assert.equal(reads, 0); assert.equal(h.calls.validated.length, 0);
});

test('context policy is an explicit selected subset and app changes cannot leave stale context consent', async t => {
  const h = fixture(t, { settings: { applications: [WORD, EDGE], contextApplications: [EDGE] }, roots: [] });
  await h.controller.start();
  await h.controller.configure({ applications: [WORD] });
  assert.deepEqual(h.controller.getSettings().contextApplications, []);
  await assert.rejects(h.controller.configure({ contextApplications: [EDGE] }));
  assert.deepEqual(h.controller.getSettings().applications, [WORD]);
  assert.equal(h.calls.samples.length, 0);
});

test('temporary consented window cues work without roots while paused and app-only access strips all hints', async t => {
  const h = fixture(t, { settings: { applications: [EDGE], contextApplications: [EDGE] }, roots: [] });
  h.hooks.sample = () => nativeWindow(); await h.controller.start();
  const token = await h.controller.captureCurrent(), id = sessionId();
  assert.equal(h.controller.bindCurrent(token, id), true);
  const value = await h.controller.currentForSession(id);
  assert.equal(value.kind, 'window'); assert.equal(value.observedAt, new Date(START).toISOString());
  assert.deepEqual(value.window, { title: 'Quarterly plan🧭', url: 'https://example.com/docs/plan' });
  assert.equal(value.temporary, true); assert.equal(value.source, 'explicit_voice_gesture'); assert.equal(value.id, undefined);
  const projected = await h.controller.currentForSession(id, undefined, { documents: false });
  assert.equal(projected.kind, 'application'); assert.equal(projected.window, undefined); assert.equal(projected.document, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /Quarterly|example\.com|window|title|url/);
  assert.equal(h.calls.samples.length, 1); assert.equal(h.calls.validated.length, 0); assert.equal(h.calls.ingested.length, 0);
  assert.equal(await h.controller.currentForSession(sessionId()), null);
  h.advance(120000); assert.equal(await h.controller.currentForSession(id), null);
});

test('current cue prefers a root-validated document, then an independently consented window', async t => {
  const h = fixture(t, { settings: { applications: [WORD], contextApplications: [WORD] } });
  h.hooks.sample = () => nativeWindow(WORD, { document: { path: '/approved/report.docx', title: 'IGNORE NATIVE DOCUMENT TITLE' } });
  await h.controller.start();
  let token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  assert.equal((await h.controller.currentForSession(id)).kind, 'document');
  assert.equal((await h.controller.currentForSession(id)).window, undefined);
  h.hooks.validate = () => null;
  token = await h.controller.captureCurrent(); id = sessionId(); h.controller.bindCurrent(token, id);
  const value = await h.controller.currentForSession(id);
  assert.equal(value.kind, 'window'); assert.equal(value.document, undefined);
  assert.doesNotMatch(JSON.stringify(value), /report\.docx|NATIVE DOCUMENT|PRIVATE/);
});

test('context revocation clears existing cue/session mappings and cancels a current source result', async t => {
  const h = fixture(t, { settings: { applications: [EDGE], contextApplications: [EDGE] }, roots: [] });
  h.hooks.sample = () => nativeWindow(); await h.controller.start();
  const token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  const gate = deferred(); h.hooks.sample = () => gate.promise;
  const pending = h.controller.captureCurrent(); await flush();
  await h.controller.configure({ contextApplications: [] });
  assert.equal(await pending, null); assert.equal(await h.controller.currentForSession(id), null);
  assert.equal(h.controller.bindCurrent(token, sessionId()), false);
  assert.equal(h.calls.samples.at(-1).signal.aborted, true);
  gate.resolve(nativeWindow()); await flush();
  assert.equal([...h.timers.values()].some(timer => timer.delay === 120000), false);
});

test('a temporary window rechecks current ledger consent even if settings were changed outside its controller', async t => {
  const h = fixture(t, { settings: { applications: [EDGE], contextApplications: [EDGE] }, roots: [] });
  h.hooks.sample = () => nativeWindow(); await h.controller.start();
  const token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  await h.ledger.configure({ contextApplications: [] }, new AbortController().signal);
  const value = await h.controller.currentForSession(id);
  assert.equal(value.kind, 'application'); assert.equal(value.window, undefined);
});

test('pending context changes fence sampling and explicit cues until consent storage is durable', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [EDGE] }, roots: [] }), gate = deferred();
  h.hooks.sample = () => nativeWindow(); await h.controller.start();
  h.hooks.configure = () => gate.promise;
  const changing = h.controller.configure({ contextApplications: [EDGE] });
  assert.equal(await h.controller.captureCurrent(), null); assert.equal(await h.tick(0), false); assert.equal(h.calls.samples.length, 0);
  gate.resolve(); await changing; await h.tick(0);
  assert.deepEqual(h.calls.samples[0].contextApplications, [EDGE]); assert.ok(h.calls.ingested[0].window);
});

test('entry lookup is a retained-ID ledger delegation, re-gates context and never samples the OS', async t => {
  const h = fixture(t, { settings: { applications: [EDGE], contextApplications: [EDGE] } });
  const row = observedWindow(); row.window.url = 'HTTPS://EXAMPLE.com/docs/plan?token=PRIVATE#PRIVATE';
  h.hooks.entry = () => row;
  const value = await h.controller.entry(row.id);
  assert.deepEqual(h.calls.entries.map(call => call.id), [row.id]); assert.ok(h.calls.entries[0].signal instanceof AbortSignal);
  assert.equal(value.window.url, 'https://example.com/docs/plan'); value.window.title = 'tampered';
  assert.equal((await h.controller.entry(row.id)).window.title, 'Quarterly plan');
  await h.controller.configure({ contextApplications: [] });
  const projected = await h.controller.entry(row.id);
  assert.equal(projected.kind, 'application'); assert.equal(projected.window, undefined);
  h.hooks.entry = () => ({ ...row, app: { id: FEISHU, name: 'PRIVATE UNSELECTED' } });
  assert.equal(await h.controller.entry(row.id), null);
  assert.equal(h.calls.samples.length, 0); assert.equal(h.calls.scopes, 0); assert.equal(h.calls.validated.length, 0);
});

test('entry lookup cancellation while a mutation drains never enters the ledger lookup', async t => {
  const h = fixture(t), gate = deferred(), caller = new AbortController();
  h.hooks.configure = () => gate.promise;
  const changing = h.controller.configure({ applications: [EDGE] });
  const reading = h.controller.entry(`wa-${randomUUID()}`, caller.signal);
  caller.abort(new Error('stop entry')); await assert.rejects(reading, /stop entry/);
  assert.equal(h.calls.entries.length, 0); gate.resolve(); await changing;
});

test('context revocation invalidates an already-dispatched entry lookup even if its ledger ignores abort', async t => {
  const h = fixture(t, { settings: { applications: [EDGE], contextApplications: [EDGE] } }), gate = deferred(), row = observedWindow();
  h.hooks.entry = () => gate.promise;
  const reading = h.controller.entry(row.id), rejected = assert.rejects(reading);
  await flush(); await h.controller.configure({ contextApplications: [] });
  await rejected; assert.equal(h.calls.entries[0].signal.aborted, true);
  gate.resolve(row); await flush(); assert.equal(h.calls.samples.length, 0);
});

test('application-only history calls neither source, discovery, roots nor document validation', async t => {
  const h = fixture(t, { settings: { applications: [EDGE], contextApplications: [EDGE] } });
  await h.controller.list({ kind: 'application', query: 'Edge' });
  assert.deepEqual(h.calls.list, { kind: 'application', query: 'Edge' });
  assert.equal(h.calls.samples.length, 0); assert.equal(h.calls.discoveries.length, 0); assert.equal(h.calls.facts, 0);
  assert.equal(h.calls.scopes, 0); assert.equal(h.calls.validated.length, 0);
});

test('application discovery is explicit, bounded and label-only, with no settings or sampling side effects', async t => {
  const h = fixture(t); await h.controller.start(); await h.controller.status();
  assert.equal(h.calls.discoveries.length, 0);
  const rows = Array.from({ length: 130 }, (_, n) => ({ id: `com.example.App-${n}`, name: `  应用🧭 ${n}\n\u0085\ud800  `, installed: true, running: true, foreground: true, body: 'PRIVATE BODY', pid: 123 }));
  h.hooks.discover = () => discovery(rows);
  const result = await h.controller.discoverApplications();
  assert.equal(result.applications.length, 128); assert.equal(result.truncated, true);
  assert.equal(result.applications[0].name, '应用🧭 0');
  assert.deepEqual(Object.keys(result.applications[0]).sort(), ['foreground', 'id', 'installed', 'name', 'running']);
  assert.equal(result.applications[0].foreground, true, 'a regular app is foreground-capable');
  assert.equal(h.calls.discoveries.length, 1); assert.equal(h.calls.samples.length, 0); assert.equal(h.calls.scopes, 0);
  assert.deepEqual(h.controller.getSettings(), { enabled: false, applications: [], retentionDays: 7, contextApplications: [] });
  const capabilities = (await h.controller.status()).capabilities;
  assert.equal(h.calls.discoveries.length, 1, 'status never performs discovery');
  assert.equal(capabilities.applications.length, 128); assert.ok(capabilities.applications.some(app => app.id === rows[0].id));
  result.applications[0].name = 'tampered'; capabilities.applications[0].name = 'tampered';
  assert.equal((await h.controller.status()).capabilities.applications.some(app => app.name === 'tampered'), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BODY|pid/);
});

test('discovery rejects malformed IDs/duplicates without inheriting native extras or expanding consent', async t => {
  const h = fixture(t, { settings: { enabled: true, applications: [WORD] }, roots: [] });
  const valid = { id: EDGE, name: 'Microsoft Edge', installed: true, running: true, foreground: true };
  h.hooks.discover = () => discovery([valid, { ...valid, name: 'PRIVATE DUPLICATE' }, { ...valid, id: `${EDGE}\u2028` }, { ...valid, id: 'invalid/id' }, { ...valid, id: FEISHU, running: false }]);
  const result = await h.controller.discoverApplications();
  assert.deepEqual(result, { applications: [valid], truncated: true });
  h.hooks.sample = () => nativeWindow(EDGE); await h.controller.start(); await h.tick(0);
  assert.deepEqual(h.calls.ingested, [{ app: null }]);
  assert.deepEqual(h.controller.getSettings().applications, [WORD]); assert.deepEqual(h.controller.getSettings().contextApplications, []);
});

test('discovery errors remain generic, an aborted caller never enumerates and disposal rejects late discovery', async t => {
  const h = fixture(t), caller = new AbortController(); caller.abort(new Error('already stopped'));
  await assert.rejects(h.controller.discoverApplications(caller.signal), /already stopped/); assert.equal(h.calls.discoveries.length, 0);
  h.hooks.discover = () => { throw new Error('PRIVATE NATIVE MESSAGE'); };
  await assert.rejects(h.controller.discoverApplications(), error => !error.message.includes('PRIVATE'));
  h.hooks.discover = () => ({ ...discovery([]), source: 'wrong source' });
  await assert.rejects(h.controller.discoverApplications(), /暂时不能/);
  const gate = deferred(); h.hooks.discover = () => gate.promise;
  const pending = h.controller.discoverApplications(), rejected = assert.rejects(pending);
  await flush(); await h.controller.dispose(); await rejected;
  assert.equal(h.calls.discoveries.at(-1).signal.aborted, true);
  gate.resolve(discovery([{ id: EDGE, name: 'Microsoft Edge', installed: true, running: true, foreground: true }])); await flush();
  assert.deepEqual(h.controller.getSettings().applications, []);
});

test('status projects safe seed facts and whitelisted reasons without native titles or arbitrary objects', async t => {
  const h = fixture(t);
  h.hooks.status = () => ({ available: true, accessibilityTrusted: true, reason: 'PRIVATE WINDOW TITLE', applications: [{ id: WORD, name: 'PRIVATE NAME', installed: { body: 'PRIVATE BODY' } }] });
  const value = await h.controller.status();
  assert.equal(value.capabilities.reason, undefined); assert.equal(value.capabilities.applications[0].installed, null);
  assert.deepEqual(value.capabilities.applications.map(app => app.name), APPLICATIONS.map(app => app.name));
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
});

test('cue expiry and canonical file identity are rechecked after a pending metadata validation', async t => {
  const h = fixture(t); await h.controller.start(); await h.selected();
  const token = await h.controller.captureCurrent(), id = sessionId(); h.controller.bindCurrent(token, id);
  h.hooks.validate = () => metadata('/approved/different.docx');
  assert.equal((await h.controller.currentForSession(id)).kind, 'application');
  const gate = deferred(); h.hooks.validate = () => gate.promise;
  const reading = h.controller.currentForSession(id); await flush(); h.advance(120000); gate.resolve(metadata('/approved/report.docx'));
  assert.equal(await reading, null);
});
