import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  ACTIVITY_RETENTION_DAYS, MAX_ACTIVITY_ENTRIES, APPLICATIONS, ActivityLedgerDomain,
  ActivityEntrySchema, ActivitySettingsSchema, createActivityLedger,
} from '../lib/activity-ledger.js';

// Only a fake StorageDomain/KvTable and synthetic metadata. These tests never
// enumerate a real application, inspect a user document, or run native/voice/Agent code.
const WORD = 'com.microsoft.Word', PPT = 'com.microsoft.Powerpoint', WPS = 'com.kingsoft.wpsoffice.mac';
const EDGE = 'com.microsoft.edgemac', FEISHU = 'com.electron.lark', DAY = 86400000, START = Date.parse('2026-11-13T12:00:00.000Z');
const appName = id => APPLICATIONS.find(app => app.id === id)?.name ?? (id === EDGE ? 'Microsoft Edge' : id === FEISHU ? '飞书' : id);
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const iso = value => new Date(value).toISOString();
const document = (file = '/allowed/report.docx', modifiedAt = iso(START - 10 * DAY)) => ({ path: file, name: file.split('/').at(-1), kind: file.endsWith('.pptx') ? 'presentation' : 'document', modifiedAt });
const snapshot = (file, app = WORD, extra = {}) => ({ app: { id: app, name: appName(app), pid: 123 }, ...(file === undefined ? {} : { document: { path: file, title: 'NEVER PERSIST THIS NATIVE TITLE' } }), ...extra });
function storedEntry({ app = WORD, at = START, file, ...extra } = {}) {
  return { id: `wa-${randomUUID()}`, app: { id: app, name: appName(app) }, observedAt: iso(at), kind: file ? 'document' : 'application', ...(file ? { document: document(file) } : {}), ...extra };
}
function fakeDomain(settings = {}) {
  const store = { global: copy(ActivityLedgerDomain.global.initial), rows: new Map(), calls: [], hooks: {}, closes: 0 };
  Object.assign(store.global.settings, settings);
  const table = {
    get: key => copy(store.rows.get(key)),
    *entries() { for (const [key, value] of store.rows) yield [key, copy(value)]; },
    async put(key, value) {
      const checked = ActivityEntrySchema.parse(value);
      store.calls.push(['put', key, copy(checked)]);
      await store.hooks.put?.(key, checked);
      store.rows.set(key, copy(checked));
    },
    async deleteMany(keys) {
      store.calls.push(['deleteMany', [...keys]]);
      await store.hooks.deleteMany?.(keys);
      let count = 0;
      for (const key of keys) count += Number(store.rows.delete(key));
      return count;
    },
  };
  const domain = {
    name: ActivityLedgerDomain.name,
    global: {
      get: () => copy(store.global),
      async set(value) {
        const checked = ActivityLedgerDomain.global.schema.parse(value);
        store.calls.push(['set', copy(checked)]);
        await store.hooks.set?.(checked);
        store.global = copy(checked);
      },
    },
    table(name) { assert.equal(name, 'entries'); return table; },
    async close() { store.closes++; },
  };
  return { store, domain, table, add(value, key = value.id) { store.rows.set(key, copy(value)); } };
}
function fixture(options = {}) {
  const storage = options.storage ?? fakeDomain(options.settings);
  let clock = options.now ?? START;
  const checks = [];
  let validator = options.validate ?? (file => file.startsWith('/allowed/') ? document(file) : null);
  const make = () => createActivityLedger({
    domain: storage.domain, now: () => clock,
    validateDocument(file, signal) { checks.push({ file, signal }); return validator(file, signal); },
  });
  const ledger = make();
  return {
    ...storage, ledger, checks, make,
    clock(value) { clock = value; },
    validator(value) { validator = value; },
    enable(applications = [WORD, PPT, WPS]) { return ledger.configure({ enabled: true, applications }); },
    json() { return JSON.stringify({ global: storage.store.global, entries: [...storage.store.rows.values()] }); },
  };
}
const assertNoNativeSecrets = fixture => {
  assert.doesNotMatch(fixture.json(), /NEVER PERSIST|UNTRUSTED NATIVE|private-secret|private-title|outside-scope/iu);
};

test('domain is real per-record StorageDomain data with strict default-off seven-day settings', () => {
  assert.equal(ActivityLedgerDomain.name, 'local_workfiles_activity');
  assert.equal(ActivityLedgerDomain.version, 1);
  assert.equal(ActivityLedgerDomain.layout, 'per-record');
  assert.equal(ACTIVITY_RETENTION_DAYS, 7);
  assert.deepEqual(ActivityLedgerDomain.global.initial, { settings: { enabled: false, applications: [], retentionDays: 7, contextApplications: [] }, cursor: null, baselineNext: false });
  for (const mutation of [
    { ...copy(ActivityLedgerDomain.global.initial), extra: true },
    { ...copy(ActivityLedgerDomain.global.initial), settings: { enabled: true, applications: ['invalid/id'], retentionDays: 7 } },
    { ...copy(ActivityLedgerDomain.global.initial), settings: { enabled: true, applications: [WORD], contextApplications: [EDGE], retentionDays: 7 } },
    { ...copy(ActivityLedgerDomain.global.initial), settings: { enabled: true, applications: [WORD, WORD], retentionDays: 7 } },
    { ...copy(ActivityLedgerDomain.global.initial), settings: { enabled: true, applications: [WORD], retentionDays: 99 } },
  ]) assert.equal(ActivityLedgerDomain.global.schema.safeParse(mutation).success, false);
  assert.deepEqual(APPLICATIONS.map(app => app.id), [WORD, PPT, WPS]);
  assert.ok(Object.isFrozen(APPLICATIONS) && APPLICATIONS.every(Object.isFrozen));
});

test('construction/settings/disabled ingest perform zero writes and zero document checks', async () => {
  const f = fixture();
  assert.deepEqual(f.ledger.getSettings(), { enabled: false, applications: [], retentionDays: 7, contextApplications: [] });
  assert.deepEqual(await f.ledger.ingest(snapshot('/allowed/report.docx')), { recorded: false, reason: 'disabled' });
  await f.ledger.configure({});
  await f.ledger.configure({ enabled: undefined, applications: undefined });
  assert.equal(f.checks.length, 0);
  assert.deepEqual(f.store.calls, []);
  const value = f.ledger.getSettings(); value.enabled = true; value.applications.push(WORD);
  assert.equal(f.ledger.getSettings().enabled, false);
  assert.deepEqual(f.ledger.getSettings().applications, []);
});

test('enabled with empty application selection still cannot ingest', async () => {
  const f = fixture();
  await f.ledger.configure({ enabled: true });
  f.store.calls.length = 0;
  assert.equal((await f.ledger.ingest(snapshot('/allowed/report.docx'))).recorded, false);
  assert.equal(f.checks.length, 0);
  assert.equal(f.store.calls.length, 0);
});

test('settings reject malformed IDs, duplicates and foreign permission fields, not non-seed apps', async () => {
  const f = fixture();
  for (const change of [
    { applications: ['invalid/id'] }, { applications: ['com..word'] }, { applications: [WORD, WORD] },
    { contextApplications: [EDGE] }, { applications: [WORD], contextApplications: [EDGE] }, { contextApplications: [WORD, WORD] },
    { retentionDays: 30 }, { enabled: 'true' }, { applications: [WORD], roots: ['/'] }, null,
  ]) await assert.rejects(f.ledger.configure(change), { code: 'INVALID_ACTIVITY_INPUT' });
  assert.equal(f.store.calls.length, 0);
});

test('only selected app identity and scoped validator metadata enter a document record', async () => {
  const f = fixture(); await f.enable();
  const result = await f.ledger.ingest(snapshot('/allowed/report.docx'));
  assert.equal(result.recorded, true);
  assert.equal(result.entry.kind, 'document');
  assert.deepEqual(result.entry.app, { id: WORD, name: 'Microsoft Word' });
  assert.deepEqual(result.entry.document, document());
  assert.equal(result.entry.observedAt, iso(START));
  assert.notEqual(result.entry.observedAt, result.entry.document.modifiedAt);
  assert.equal(Object.hasOwn(result.entry.app, 'pid'), false);
  result.entry.document.path = '/private-secret/tampered.docx';
  const listed = await f.ledger.list();
  assert.equal(listed.entries[0].document.path, '/allowed/report.docx');
  assertNoNativeSecrets(f);
});

test('native timestamp or foreign context fields cannot supply an observation time or body', async () => {
  const f = fixture(); await f.enable(); f.store.calls.length = 0;
  for (const value of [
    snapshot('/allowed/report.docx', WORD, { observedAt: '1900-01-01T00:00:00.000Z' }),
    snapshot('/allowed/report.docx', WORD, { text: 'private-secret body' }),
    { app: { id: WORD, name: 'ok', pid: 1, allowed: true } },
    { app: { id: WORD }, document: { path: '/allowed/report.docx', title: 'ok', scope: 'trusted' } },
  ]) assert.deepEqual(await f.ledger.ingest(value), { recorded: false, reason: 'invalid' });
  assert.equal(f.checks.length, 0);
  assert.equal(f.store.calls.length, 0);
});

test('unknown, Edge, unselected and null foreground sources cause no writes or validators', async () => {
  const f = fixture(); await f.enable([WORD]); f.store.calls.length = 0;
  for (const value of [snapshot('/allowed/report.docx', EDGE), snapshot('/allowed/report.docx', PPT), snapshot('/allowed/report.docx', '__proto__'), { app: null }]) {
    assert.equal((await f.ledger.ingest(value)).recorded, false);
  }
  assert.equal(f.checks.length, 0);
  assert.equal(f.store.calls.length, 0);
});

for (const file of ['relative.docx', 'file:///allowed/report.docx', '/allowed/../private-secret/a.docx', '/allowed//a.docx', '/allowed/a\u0000.docx', '/allowed/a\\b.docx', '/']) {
  test(`malformed native local path cannot be persisted or sent to validator (${JSON.stringify(file)})`, async () => {
    const f = fixture(); await f.enable([WORD]);
    const result = await f.ledger.ingest(snapshot(file));
    assert.equal(result.entry.kind, 'application');
    assert.equal(f.checks.length, 0);
    assertNoNativeSecrets(f);
    assert.deepEqual(Object.keys(result.entry).sort(), ['app', 'id', 'kind', 'observedAt']);
  });
}

for (const result of [null, false, { ...document(), name: 'private-title' }, { ...document(), path: 'relative.docx' }, { ...document(), kind: 'executable' }, { ...document(), modifiedAt: 'yesterday' }, { ...document(), scope: 'trusted' }]) {
  test(`validator failure/foreign metadata only permits application-level data (${JSON.stringify(result)})`, async () => {
    const f = fixture({ validate: () => result }); await f.enable([WORD]);
    const value = await f.ledger.ingest(snapshot('/outside-scope/private-secret.docx'));
    assert.equal(value.entry.kind, 'application');
    assertNoNativeSecrets(f);
  });
}

test('a throwing scope validator leaks neither its message nor a native title/path', async () => {
  const f = fixture({ validate: () => { throw new Error('/private-secret/private-title'); } }); await f.enable([WORD]);
  const value = await f.ledger.ingest(snapshot('/outside-scope/private-secret.docx'));
  assert.equal(value.entry.kind, 'application');
  assertNoNativeSecrets(f);
});

test('canonical validator path replaces native path, and canonical aliases are deduplicated', async () => {
  const f = fixture({ validate: () => document('/allowed/canonical.docx') }); await f.enable([WORD]);
  const first = await f.ledger.ingest(snapshot('/outside-scope/alias.docx'));
  assert.equal(first.entry.document.path, '/allowed/canonical.docx');
  assert.equal((await f.ledger.ingest(snapshot('/another-alias.docx'))).reason, 'duplicate');
  assert.equal(f.store.rows.size, 1);
  assertNoNativeSecrets(f);
});

test('same document does not become edit-history when mtime, title or pid changes', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/report.docx'));
  f.clock(START + 5000);
  f.validator(file => document(file, iso(START + 4000)));
  const value = snapshot('/allowed/report.docx'); value.app.pid = 456; value.document.title = 'Edited edited edited';
  assert.equal((await f.ledger.ingest(value)).reason, 'duplicate');
  assert.equal(f.store.rows.size, 1);
  assert.equal([...f.store.rows.values()][0].observedAt, iso(START));
});

test('eligible document and app transitions record distinct observations, including returning to a document', async () => {
  const f = fixture(); await f.enable();
  for (const [index, value] of [snapshot('/allowed/a.docx'), snapshot('/allowed/b.docx'), snapshot('/allowed/deck.pptx', PPT), snapshot('/allowed/a.docx')].entries()) {
    f.clock(START + index);
    assert.equal((await f.ledger.ingest(value)).recorded, true);
  }
  const result = await f.ledger.list();
  assert.equal(result.entries.length, 4);
  assert.deepEqual(result.entries.map(entry => entry.document.path), ['/allowed/a.docx', '/allowed/deck.pptx', '/allowed/b.docx', '/allowed/a.docx']);
});

test('invalid document changes in the same app do not store private filenames', async () => {
  const f = fixture({ validate: () => null }); await f.enable([WORD]);
  assert.equal((await f.ledger.ingest(snapshot('/outside-scope/private-secret-1.docx'))).recorded, true);
  assert.equal((await f.ledger.ingest(snapshot('/outside-scope/private-secret-2.docx'))).reason, 'duplicate');
  assert.equal(f.store.rows.size, 1);
  assertNoNativeSecrets(f);
});

test('persistence survives factory disposal/recreation; factory never closes caller-owned domain', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/a.docx'));
  await f.ledger.dispose(); await f.ledger.dispose();
  assert.equal(f.store.closes, 0);
  const restored = f.make();
  assert.deepEqual(restored.getSettings(), { enabled: true, applications: [WORD], retentionDays: 7, contextApplications: [] });
  assert.equal((await restored.list()).entries[0].document.path, '/allowed/a.docx');
  assert.equal((await restored.ingest(snapshot('/allowed/a.docx'))).reason, 'duplicate');
  assert.equal((await restored.ingest(snapshot('/allowed/b.docx'))).recorded, true);
  await restored.dispose();
});

test('TTL uses observedAt, expires exactly at seven days, and ignores document modification age', async () => {
  const f = fixture({ settings: { enabled: true, applications: [WORD] } });
  const expired = storedEntry({ at: START - 7 * DAY, file: '/allowed/expired.docx' });
  const retained = storedEntry({ at: START - 7 * DAY + 1, file: '/allowed/retained.docx' });
  const future = storedEntry({ at: START + 1, file: '/allowed/future.docx' });
  f.add(expired); f.add(retained); f.add(future);
  const result = await f.ledger.list();
  assert.deepEqual(result.entries.map(entry => entry.id), [retained.id]);
  assert.equal(f.store.rows.has(expired.id), false);
  assert.equal(f.store.rows.has(future.id), false);
  assert.equal(result.entries[0].document.modifiedAt, iso(START - 10 * DAY));
});

test('capacity retains the newest bounded records and queries expose at most twenty', async () => {
  const f = fixture({ settings: { enabled: true, applications: [WORD] } });
  for (let index = 0; index < MAX_ACTIVITY_ENTRIES + 5; index++) f.add(storedEntry({ at: START - index }));
  assert.equal((await f.ledger.list()).entries.length, 8);
  assert.equal(f.store.rows.size, MAX_ACTIVITY_ENTRIES);
  assert.equal((await f.ledger.list({ limit: 20 })).entries.length, 20);
  assert.deepEqual(await f.ledger.stats(), { count: MAX_ACTIVITY_ENTRIES, lastObservedAt: iso(START), retentionDays: 7 });
  assert.equal(f.checks.length, 0);
});

test('query text/time limits are strict, lower-inclusive and upper-exclusive', async () => {
  const f = fixture({ settings: { enabled: true, applications: [WORD] } });
  for (let index = 0; index < 4; index++) f.add(storedEntry({ at: START - index * 1000, file: `/allowed/report-${index}.docx` }));
  const result = await f.ledger.list({ query: 'REPORT', after: iso(START - 2000), before: iso(START), limit: 20 });
  assert.deepEqual(result.entries.map(entry => entry.document.name), ['report-1.docx', 'report-2.docx']);
  for (const input of [{ limit: 21 }, { limit: 0 }, { limit: 1.5 }, { after: 'yesterday' }, { after: iso(START), before: iso(START) }, { enabled: true }, { query: 'x'.repeat(513) }]) {
    await assert.rejects(f.ledger.list(input), { code: 'INVALID_ACTIVITY_INPUT' });
  }
});

test('malformed persisted data, unsafe app labels and key mismatches never become query authority', async () => {
  const f = fixture({ settings: { enabled: true, applications: [WORD] } });
  f.add(storedEntry({ file: '/private-secret/private-title.docx' }));
  const extra = storedEntry(); extra.title = 'private-title'; f.add(extra);
  const name = storedEntry(); name.app.name = 'private-title\u0000'; f.add(name);
  const mismatch = storedEntry(); f.add(mismatch, `wa-${randomUUID()}`);
  const unknown = storedEntry(); unknown.app.id = EDGE; f.add(unknown);
  const entries = (await f.ledger.list()).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'application');
  assertNoNativeSecrets(f);
  assert.equal(f.store.rows.size, 1);
});

test('scope revocation in list physically removes stored document fields and reruns query matching', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/report.docx'));
  f.validator(() => null);
  assert.deepEqual((await f.ledger.list({ query: 'report' })).entries, []);
  const saved = [...f.store.rows.values()][0];
  assert.equal(saved.kind, 'application');
  assert.equal(Object.hasOwn(saved, 'document'), false);
  assert.doesNotMatch(f.json(), /report\.docx|modifiedAt/u);
});

test('explicit purge revalidates every document and downgrades revoked scope on disk', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/a.docx')); f.clock(START + 1);
  await f.ledger.ingest(snapshot('/allowed/b.docx')); f.clock(START + 2);
  await f.ledger.ingest(snapshot('/allowed/a.docx'));
  f.checks.length = 0;
  f.validator(() => null);
  await f.ledger.purge();
  assert.equal(f.checks.length, 2, 'same document path is only validated once per purge');
  assert.ok([...f.store.rows.values()].every(entry => entry.kind === 'application'));
  assert.doesNotMatch(f.json(), /\/allowed\/|modifiedAt/u);
});

test('a now-different canonical target is not returned as the old document', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/a.docx'));
  f.validator(() => document('/allowed/b.docx'));
  assert.equal((await f.ledger.list()).entries[0].kind, 'application');
  assert.doesNotMatch(f.json(), /a\.docx|b\.docx/u);
});

test('pause keeps existing history readable; removing an app deletes its records and consent cursor', async () => {
  const f = fixture(); await f.enable([WORD, PPT]);
  await f.ledger.ingest(snapshot('/allowed/a.docx')); f.clock(START + 1);
  await f.ledger.ingest(snapshot('/allowed/deck.pptx', PPT));
  await f.ledger.configure({ enabled: false });
  assert.equal(f.store.rows.size, 2);
  assert.equal((await f.ledger.list()).entries.length, 2);
  f.store.calls.length = 0;
  assert.equal((await f.ledger.ingest(snapshot('/allowed/b.docx'))).reason, 'disabled');
  assert.equal(f.store.calls.length, 0);
  await f.ledger.configure({ applications: [WORD] });
  assert.equal(f.store.rows.size, 1);
  assert.ok([...f.store.rows.values()].every(value => value.app.id === WORD));
  assert.equal(f.store.global.cursor, null);
});

test('clear does not change enabled/app selection, and same foreground cannot refill it', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/a.docx'));
  assert.deepEqual(await f.ledger.clear(), { cleared: 1 });
  assert.equal(f.ledger.getSettings().enabled, true);
  assert.deepEqual(f.ledger.getSettings().applications, [WORD]);
  f.store.calls.length = 0;
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).reason, 'duplicate');
  assert.equal(f.store.rows.size, 0);
  assert.equal(f.store.calls.length, 0);
  assert.equal((await f.ledger.ingest(snapshot('/allowed/b.docx'))).recorded, true);
});

test('clear tombstone survives factory recreation without retaining the document path', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/a.docx'));
  await f.ledger.clear(); await f.ledger.dispose();
  assert.doesNotMatch(f.json(), /\/allowed\/a\.docx/u);
  const restored = f.make();
  assert.equal((await restored.ingest(snapshot('/allowed/a.docx'))).reason, 'duplicate');
  assert.equal(f.store.rows.size, 0);
  assert.equal((await restored.ingest(snapshot('/allowed/b.docx'))).recorded, true);
});

test('clear with unknown current sample only establishes a safe baseline, never refills immediately', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.clear();
  assert.equal(f.store.global.baselineNext, true);
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).reason, 'baseline');
  assert.equal(f.store.rows.size, 0);
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).reason, 'duplicate');
  assert.equal((await f.ledger.ingest(snapshot('/allowed/b.docx'))).recorded, true);
});

test('revoke and newly select an app after clear does not leave a stale raw suppression', async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/a.docx')); await f.ledger.clear();
  await f.ledger.configure({ applications: [] });
  await f.ledger.configure({ applications: [WORD] });
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).recorded, true);
});

for (const action of ['pause', 'revoke', 'clear', 'dispose']) {
  test(`${action} does not wait for an uncooperative validator and late results cannot write`, { timeout: 2000 }, async () => {
    const started = deferred(), pending = deferred();
    const f = fixture({ validate: () => { started.resolve(); return pending.promise; } }); await f.enable([WORD]);
    f.store.calls.length = 0;
    const ingestion = f.ledger.ingest(snapshot('/allowed/a.docx'));
    await started.promise;
    if (action === 'pause') await f.ledger.configure({ enabled: false });
    if (action === 'revoke') await f.ledger.configure({ applications: [] });
    if (action === 'clear') await f.ledger.clear();
    if (action === 'dispose') await f.ledger.dispose();
    assert.equal((await ingestion).recorded, false);
    pending.resolve(document('/allowed/a.docx')); await flush();
    assert.equal(f.store.rows.size, 0);
    assert.equal(f.store.calls.filter(([name]) => name === 'put').length, 0);
    assert.equal(f.store.closes, 0);
  });
}

test('pause followed by resume cannot revive a previous generation validator result', { timeout: 2000 }, async () => {
  const started = deferred(), late = deferred();
  const f = fixture({ validate: () => { started.resolve(); return late.promise; } }); await f.enable([WORD]);
  const old = f.ledger.ingest(snapshot('/allowed/a.docx')); await started.promise;
  await f.ledger.configure({ enabled: false }); await f.ledger.configure({ enabled: true });
  late.resolve(document('/allowed/a.docx'));
  assert.equal((await old).recorded, false);
  assert.equal(f.store.rows.size, 0);
  f.validator(file => document(file));
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).recorded, true);
});

test('caller abort settles a validator that ignores AbortSignal and prevents every late write', { timeout: 2000 }, async () => {
  const started = deferred(), late = deferred(), controller = new AbortController();
  const f = fixture({ validate: () => { started.resolve(); return late.promise; } }); await f.enable([WORD]);
  f.store.calls.length = 0;
  const old = f.ledger.ingest(snapshot('/allowed/a.docx'), controller.signal); await started.promise;
  const rejected = assert.rejects(old, { name: 'AbortError' }); controller.abort(); await rejected;
  late.resolve(document('/allowed/a.docx')); await flush();
  assert.equal(f.store.rows.size, 0);
  assert.equal(f.store.calls.length, 0);
});

test('a newer different observation wins over an older slow validator', { timeout: 2000 }, async () => {
  const started = deferred(), late = deferred();
  const f = fixture({ validate: file => file.endsWith('/a.docx') ? (started.resolve(), late.promise) : document(file) }); await f.enable([WORD]);
  const old = f.ledger.ingest(snapshot('/allowed/a.docx')); await started.promise;
  f.clock(START + 10);
  const newer = await f.ledger.ingest(snapshot('/allowed/b.docx'));
  assert.equal(newer.recorded, true);
  late.resolve(document('/allowed/a.docx'));
  assert.equal((await old).recorded, false);
  assert.deepEqual([...f.store.rows.values()].map(value => value.document.path), ['/allowed/b.docx']);
});

test('repeated same input while validation is pending does not restart/starve it', { timeout: 2000 }, async () => {
  const started = deferred(), late = deferred();
  const f = fixture({ validate: () => { started.resolve(); return late.promise; } }); await f.enable([WORD]);
  const old = f.ledger.ingest(snapshot('/allowed/a.docx')); await started.promise;
  f.clock(START + 1000);
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).reason, 'pending');
  assert.equal(f.checks.length, 1);
  late.resolve(document('/allowed/a.docx'));
  assert.equal((await old).entry.observedAt, iso(START));
});

test('clear during pending validation drops the late document and establishes next baseline', { timeout: 2000 }, async () => {
  const started = deferred(), late = deferred();
  const f = fixture({ validate: () => { started.resolve(); return late.promise; } }); await f.enable([WORD]);
  const old = f.ledger.ingest(snapshot('/allowed/a.docx')); await started.promise;
  await f.ledger.clear();
  late.resolve(document('/allowed/a.docx')); assert.equal((await old).recorded, false);
  f.validator(file => document(file));
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).reason, 'baseline');
  assert.equal(f.store.rows.size, 0);
  assert.equal((await f.ledger.ingest(snapshot('/allowed/b.docx'))).recorded, true);
});

test('returning to a clear-suppressed object invalidates a pending different document', { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([WORD]);
  await f.ledger.ingest(snapshot('/allowed/a.docx')); await f.ledger.clear();
  const started = deferred(), late = deferred();
  f.validator(() => { started.resolve(); return late.promise; });
  const b = f.ledger.ingest(snapshot('/allowed/b.docx')); await started.promise;
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).reason, 'duplicate');
  late.resolve(document('/allowed/b.docx'));
  assert.equal((await b).recorded, false);
  assert.equal(f.store.rows.size, 0);
});

for (const action of ['pause', 'revoke', 'clear', 'dispose']) {
  test(`${action} joins already-dispatched uncancellable storage writes and removes stale entries`, { timeout: 2000 }, async () => {
    const f = fixture(); await f.enable([WORD]);
    const started = deferred(), release = deferred();
    f.store.hooks.put = () => { started.resolve(); return release.promise; };
    const ingestion = f.ledger.ingest(snapshot('/allowed/a.docx')); await started.promise;
    const control = action === 'pause' ? f.ledger.configure({ enabled: false }) : action === 'revoke' ? f.ledger.configure({ applications: [] }) : action === 'clear' ? f.ledger.clear() : f.ledger.dispose();
    release.resolve();
    await control;
    assert.equal((await ingestion).recorded, false);
    assert.equal(f.store.rows.size, 0);
  });
}

test('late global cursor persistence cannot restore a row after pause', { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([WORD]);
  const started = deferred(), release = deferred();
  f.store.hooks.set = value => { if (value.cursor && value.settings.enabled) { started.resolve(); return release.promise; } };
  const ingestion = f.ledger.ingest(snapshot('/allowed/a.docx')); await started.promise;
  const pause = f.ledger.configure({ enabled: false }); release.resolve();
  await pause; assert.equal((await ingestion).recorded, false);
  assert.equal(f.store.rows.size, 0);
  assert.equal(f.store.global.settings.enabled, false);
});

test('a pending list cannot expose its formerly valid scope after clear', { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([WORD]); await f.ledger.ingest(snapshot('/allowed/a.docx'));
  const started = deferred(), late = deferred();
  f.validator(() => { started.resolve(); return late.promise; });
  const reading = f.ledger.list(); await started.promise;
  await f.ledger.clear();
  assert.deepEqual((await reading).entries, []);
  late.resolve(document('/allowed/a.docx')); await flush();
  assert.equal(f.store.rows.size, 0);
});

test('scope purge invalidates an older read while physically downgrading the revoked documents', { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([WORD]); await f.ledger.ingest(snapshot('/allowed/a.docx'));
  const started = deferred(), late = deferred();
  f.validator(() => { started.resolve(); return late.promise; });
  const reading = f.ledger.list(); await started.promise;
  f.validator(() => null); await f.ledger.purge();
  assert.deepEqual((await reading).entries, []);
  late.resolve(document('/allowed/a.docx')); await flush();
  assert.ok([...f.store.rows.values()].every(entry => entry.kind === 'application'));
});

test('concurrent partial settings changes serialize without losing a pause or app revocation', async () => {
  const f = fixture(); await f.enable([WORD, PPT]);
  const pause = f.ledger.configure({ enabled: false });
  const revoke = f.ledger.configure({ applications: [PPT] });
  await Promise.all([pause, revoke]);
  assert.deepEqual(f.ledger.getSettings(), { enabled: false, applications: [PPT], retentionDays: 7, contextApplications: [] });
  assert.deepEqual(f.store.global.settings, f.ledger.getSettings());
});

test('storage failure stops collection and compensates a partially saved entry', async () => {
  const f = fixture(); await f.enable([WORD]);
  f.store.hooks.set = () => { throw new Error('synthetic persistence failure'); };
  await assert.rejects(f.ledger.ingest(snapshot('/allowed/a.docx')), { code: 'ACTIVITY_STORAGE_UNAVAILABLE' });
  assert.equal(f.store.rows.size, 0);
  assert.equal(f.ledger.getSettings().enabled, false);
  f.store.calls.length = 0;
  assert.equal((await f.ledger.ingest(snapshot('/allowed/b.docx'))).reason, 'disabled');
  assert.equal(f.store.calls.length, 0);
  f.store.hooks.set = undefined;
  await f.ledger.configure({ enabled: true });
  assert.equal((await f.ledger.ingest(snapshot('/allowed/b.docx'))).recorded, true);
});

test('corrupt global settings fail closed instead of restoring implicit consent', () => {
  const storage = fakeDomain(); storage.store.global.settings.applications = ['invalid/id'];
  assert.throws(() => createActivityLedger({ domain: storage.domain, validateDocument: () => null }), { code: 'INVALID_ACTIVITY_STORAGE' });
  assert.equal(storage.store.calls.length, 0);
});

test('dispose settles only ledger work, rejects later mutations/queries and leaves domain ownership alone', async () => {
  const f = fixture(); await f.enable([WORD]); await f.ledger.dispose();
  assert.equal((await f.ledger.ingest(snapshot('/allowed/a.docx'))).reason, 'disposed');
  for (const method of [() => f.ledger.configure({ enabled: true }), () => f.ledger.list(), () => f.ledger.clear(), () => f.ledger.purge(), () => f.ledger.stats()]) {
    await assert.rejects(method(), { code: 'ACTIVITY_DISPOSED' });
  }
  assert.equal(f.store.closes, 0);
});

test('an unselected foreground resets dedup without storing its identity, so Word can appear again', async () => {
  const f = fixture(); await f.enable([WORD]);
  assert.equal((await f.ledger.ingest(snapshot(undefined))).recorded, true);
  assert.equal((await f.ledger.ingest(snapshot(undefined, EDGE))).reason, 'unselected');
  assert.equal(f.store.global.cursor, null); assert.doesNotMatch(f.json(), /edgemac/);
  assert.equal((await f.ledger.ingest(snapshot(undefined))).recorded, true);
  assert.equal(f.store.rows.size, 2); assert.equal(f.checks.length, 0);
});

test('seven-day maintenance also expires the hashed dedup cursor; identical later presence is not suppressed forever', async () => {
  const f = fixture(); await f.enable([WORD]); await f.ledger.ingest(snapshot(undefined));
  assert.equal(f.store.global.cursor.observedAt, iso(START));
  f.clock(START + 7 * DAY + 1); await f.ledger.purge();
  assert.equal(f.store.rows.size, 0); assert.equal(f.store.global.cursor, null);
  assert.equal((await f.ledger.ingest(snapshot(undefined))).recorded, true);
  assert.equal(f.store.rows.size, 1);
});

test('clear suppression cannot retain an old document hash beyond its seven-day privacy lifetime', async () => {
  const f = fixture(); await f.enable([WORD]); await f.ledger.ingest(snapshot('/allowed/report.docx')); await f.ledger.clear();
  assert.equal((await f.ledger.ingest(snapshot('/allowed/report.docx'))).reason, 'duplicate');
  f.clock(START + 7 * DAY + 1); await f.ledger.purge();
  assert.equal(f.store.global.cursor, null); assert.equal(f.store.rows.size, 0);
  assert.equal((await f.ledger.ingest(snapshot('/allowed/report.docx'))).recorded, true);
});

test('app-only aggregate covers all retained matches before slicing, with no document names or metadata checks', async () => {
  const f = fixture(); await f.enable();
  for (let n = 0; n < 12; n++) f.add(storedEntry({ at: START - n * 1000, file: `/allowed/word-${n}.docx` }));
  f.add(storedEntry({ app: PPT, at: START - 20000, file: '/allowed/slides.pptx' }));
  f.add(storedEntry({ app: WPS, at: START - 30000, file: '/allowed/other.docx' }));
  const result = await f.ledger.list({ kind: 'application', limit: 1 });
  assert.equal(result.entries.length, 1); assert.equal(result.matchedCount, 14); assert.equal(result.truncated, true);
  assert.deepEqual(result.applications.map(group => group.app.id), [WORD, PPT, WPS]);
  assert.equal(result.applications[0].observations, 12); assert.equal(f.checks.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /allowed|word-0|slides\.pptx|document/);
});

test('document-only filter is applied before the result limit, not after newer app-only rows hide the file', async () => {
  const f = fixture(); await f.enable();
  for (let n = 0; n < 12; n++) f.add(storedEntry({ at: START - n * 1000 }));
  f.add(storedEntry({ app: PPT, at: START - 20000, file: '/allowed/slides.pptx' }));
  const result = await f.ledger.list({ kind: 'document', limit: 1 });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].app.id, PPT);
  assert.equal(result.matchedCount, 1); assert.equal(result.truncated, false);
});

test('document query downgrades revoked metadata persistently and excludes it from the document aggregate', async () => {
  const f = fixture(); await f.enable(); const row = storedEntry({ file: '/revoked/private.docx' }); f.add(row);
  const result = await f.ledger.list({ kind: 'document' });
  assert.deepEqual(result.entries, []); assert.deepEqual(result.applications, []); assert.equal(result.matchedCount, 0);
  assert.equal(f.store.rows.get(row.id).kind, 'application'); assert.doesNotMatch(f.json(), /private\.docx/);
});

test('app-only text filters match app names, not undisclosed stored document titles', async () => {
  const f = fixture(); await f.enable(); f.add(storedEntry({ file: '/allowed/private-topic.docx' }));
  assert.equal((await f.ledger.list({ kind: 'application', query: 'private-topic' })).matchedCount, 0);
  assert.equal(f.checks.length, 0);
  assert.equal((await f.ledger.list({ kind: 'application', query: 'Microsoft Word' })).matchedCount, 1);
  assert.equal((await f.ledger.list({ kind: 'document', query: 'private-topic' })).matchedCount, 1);
});

test('clear queued behind app revocation cannot restore a forbidden cursor or fail its global schema', async () => {
  const f = fixture(); await f.enable([WORD, PPT]); await f.ledger.ingest(snapshot('/allowed/report.docx'));
  await Promise.all([f.ledger.configure({ applications: [PPT] }), f.ledger.clear()]);
  assert.equal(f.store.global.cursor, null); assert.equal(f.store.rows.size, 0);
  assert.deepEqual(f.ledger.getSettings(), { enabled: true, applications: [PPT], retentionDays: 7, contextApplications: [] });
});

const windowSnapshot = (app = EDGE, window = { title: '季度计划🧭', url: 'https://EXAMPLE.com/docs/plan?token=PRIVATE#PRIVATE' }, file) => snapshot(file, app, { window });
const windowEntry = ({ app = EDGE, window = { title: '季度计划', url: 'https://example.com/docs/plan' }, ...rest } = {}) => storedEntry({ app, ...rest, kind: 'window', window });

for (const enabled of [false, true]) test(`realistic version-1 settings/rows/cursor decode in place with no extra consent (enabled=${enabled})`, async () => {
  const storage = fakeDomain();
  const oldDocument = storedEntry({ file: '/allowed/legacy.docx' });
  const oldApp = storedEntry({ app: PPT, at: START - 1000 });
  const key = createHash('sha256').update(`${WORD}\u0000document\u0000/allowed/legacy.docx`).digest('hex');
  const oldGlobal = { settings: { enabled, applications: [WORD, PPT], retentionDays: 7 }, cursor: { appId: WORD, key, observedAt: iso(START) }, baselineNext: false };
  storage.store.global = copy(oldGlobal); storage.add(oldDocument); storage.add(oldApp);
  const parsed = ActivityLedgerDomain.global.schema.parse(copy(oldGlobal));
  assert.deepEqual(parsed.settings, { ...oldGlobal.settings, contextApplications: [] });
  assert.deepEqual(parsed.cursor, oldGlobal.cursor);
  assert.deepEqual(ActivityEntrySchema.parse(oldDocument), oldDocument);
  assert.deepEqual(ActivityEntrySchema.parse(oldApp), oldApp);
  const f = fixture({ storage });
  assert.deepEqual(f.ledger.getSettings(), parsed.settings);
  assert.deepEqual(storage.store.global, oldGlobal, 'decoding does not reset/rewrite persisted user state');
  assert.deepEqual(storage.store.calls, []);
  assert.equal((await f.ledger.ingest(snapshot('/allowed/legacy.docx'))).reason, enabled ? 'duplicate' : 'disabled');
  assert.deepEqual((await f.ledger.list()).entries.map(value => value.id), [oldDocument.id, oldApp.id]);
  assert.equal(f.ledger.getSettings().enabled, enabled);
  assert.deepEqual(f.ledger.getSettings().contextApplications, []);
});

test('version-1 decoder keeps the previous local-document filename contract', () => {
  const row = storedEntry({ file: '/allowed/legacy-\u0085.docx' });
  assert.equal(ActivityEntrySchema.safeParse(row).success, true);
});

test('settings accept up to 128 dynamic IDs and intersect context on ordinary app changes', async () => {
  const f = fixture(), applications = Array.from({ length: 128 }, (_, n) => `com.example.Editor-${n}`);
  await f.ledger.configure({ applications, contextApplications: applications });
  assert.equal(f.ledger.getSettings().enabled, false);
  assert.deepEqual(f.ledger.getSettings().applications, applications);
  assert.deepEqual(f.ledger.getSettings().contextApplications, applications);
  for (const change of [{ applications: [...applications, 'com.example.extra'] }, { applications: ['com.' + 'x'.repeat(252)] }, { applications: Array(2) }, { contextApplications: [...applications, 'com.example.extra'] }]) {
    await assert.rejects(f.ledger.configure(change), { code: 'INVALID_ACTIVITY_INPUT' });
  }
  await f.ledger.configure({ applications: applications.slice(0, 2) });
  assert.deepEqual(f.ledger.getSettings().contextApplications, applications.slice(0, 2));
  const before = f.json();
  await assert.rejects(f.ledger.configure({ applications: [applications[0]], contextApplications: applications.slice(0, 2) }), { code: 'INVALID_ACTIVITY_INPUT' });
  assert.equal(f.json(), before);
  assert.equal(ActivitySettingsSchema.safeParse({ enabled: false, applications: [EDGE], retentionDays: 7 }).success, true);
});

test('Edge and Feishu are recordable only when selected, and selection alone permits no window hints', async () => {
  const f = fixture(); await f.enable([WORD]);
  for (const app of [EDGE, FEISHU]) assert.equal((await f.ledger.ingest(windowSnapshot(app))).recorded, false);
  assert.equal(f.checks.length, 0); assert.equal(f.store.rows.size, 0);
  await f.ledger.configure({ applications: [EDGE, FEISHU] });
  for (const app of [EDGE, FEISHU]) {
    const result = await f.ledger.ingest(windowSnapshot(app));
    assert.equal(result.recorded, true); assert.equal(result.entry.kind, 'application');
    assert.deepEqual(result.entry.app, { id: app, name: appName(app) });
  }
  assert.equal(f.checks.length, 0);
  assert.doesNotMatch(f.json(), /季度|example\.com|token|PRIVATE|window|pid/);
});

test('selected native app labels are sanitized, bounded data rather than catalog-enforced names', async () => {
  const f = fixture(); await f.enable([FEISHU]);
  const result = await f.ledger.ingest({ app: { id: FEISHU, name: '  飞书🧭\n\u0000\u0085\ud800  ', pid: 77 } });
  assert.deepEqual(result.entry.app, { id: FEISHU, name: '飞书🧭' });
  assert.equal(Object.hasOwn(result.entry.app, 'pid'), false);
  assert.equal((await f.ledger.list({ kind: 'application', query: '飞书' })).matchedCount, 1);
});

test('separately consented windows need no local root or document validator, and use host observation time', async () => {
  const f = fixture(); await f.enable([EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  const result = await f.ledger.ingest(windowSnapshot());
  assert.equal(result.entry.kind, 'window'); assert.equal(result.entry.observedAt, iso(START));
  assert.deepEqual(result.entry.window, { title: '季度计划🧭', url: 'https://example.com/docs/plan' });
  assert.deepEqual(Object.keys(result.entry).sort(), ['app', 'id', 'kind', 'observedAt', 'window']);
  assert.equal(f.checks.length, 0); assert.doesNotMatch(f.json(), /token|PRIVATE|pid|document/);
  result.entry.window.url = 'https://tampered.example/';
  assert.equal((await f.ledger.list({ kind: 'document' })).entries[0].window.url, 'https://example.com/docs/plan');
  assert.equal((await f.ledger.list({ kind: 'window', query: '季度 example.com' })).matchedCount, 1);
  assert.equal((await f.ledger.list({ kind: 'application', query: '季度' })).matchedCount, 0);
  assert.equal((await f.ledger.list({ kind: 'application', query: 'example.com' })).matchedCount, 0);
  const projected = await f.ledger.list({ kind: 'application', query: 'Edge' });
  assert.equal(projected.matchedCount, 1); assert.doesNotMatch(JSON.stringify(projected), /季度|example\.com|window|url|title/);
  assert.equal(f.checks.length, 0);
});

test('authorized canonical local documents take priority over additional window hints', async () => {
  const f = fixture(); await f.enable([WORD]); await f.ledger.configure({ contextApplications: [WORD] });
  const result = await f.ledger.ingest(windowSnapshot(WORD, { title: 'DO NOT PERSIST WINDOW', url: 'https://example.com/unused' }, '/allowed/report.docx'));
  assert.equal(result.entry.kind, 'document'); assert.equal(result.entry.window, undefined);
  assert.doesNotMatch(f.json(), /DO NOT PERSIST WINDOW|example\.com/);
  f.validator(() => null);
  const fallback = await f.ledger.ingest(windowSnapshot(WORD, { title: 'Allowed window', url: 'https://example.com/fallback' }, '/revoked/report.docx'));
  assert.equal(fallback.entry.kind, 'window'); assert.equal(fallback.entry.document, undefined);
  assert.doesNotMatch(f.json(), /\/revoked\//);
});

test('unconsented window objects are opaque and polluted metadata cannot become a row field', async () => {
  let reads = 0;
  const f = fixture(); await f.enable([EDGE]);
  const opaque = Object.defineProperty({}, 'title', { enumerable: true, get() { reads++; throw new Error('PRIVATE'); } });
  assert.equal((await f.ledger.ingest(windowSnapshot(EDGE, opaque))).entry.kind, 'application');
  assert.equal(reads, 0);
  await f.ledger.configure({ contextApplications: [EDGE] });
  for (const window of [{ title: 'PRIVATE', body: 'PRIVATE BODY' }, { title: 'PRIVATE', path: '/private/body' }, JSON.parse('{"title":"PRIVATE","__proto__":{"polluted":true}}'), { url: 'https://127.0.0.1/private' }, { url: 'javascript:alert(1)' }]) {
    await f.ledger.ingest({ app: null });
    assert.equal((await f.ledger.ingest(windowSnapshot(EDGE, window))).entry.kind, 'application');
  }
  assert.doesNotMatch(f.json(), /PRIVATE|127\.0\.0\.1|javascript|polluted|\/private/);
  assert.equal({}.polluted, undefined); assert.equal(f.checks.length, 0);
});

test('context revocation strips historical windows physically but preserves root-authorized local documents', async () => {
  const f = fixture(); await f.enable([WORD, EDGE]); await f.ledger.configure({ contextApplications: [WORD, EDGE] });
  const window = (await f.ledger.ingest(windowSnapshot())).entry; f.clock(START + 1);
  const local = (await f.ledger.ingest(snapshot('/allowed/report.docx'))).entry;
  f.checks.length = 0;
  await f.ledger.configure({ contextApplications: [] });
  assert.equal(f.checks.length, 0, 'settings revocation does not re-read local documents');
  assert.deepEqual(f.store.rows.get(window.id), { id: window.id, app: window.app, observedAt: window.observedAt, kind: 'application' });
  assert.deepEqual(f.store.rows.get(local.id), local);
  assert.doesNotMatch(f.json(), /季度|example\.com|"window"|"url"|"title"/);
  assert.equal((await f.ledger.ingest(snapshot('/allowed/report.docx'))).reason, 'duplicate');
  assert.deepEqual((await f.ledger.list({ kind: 'document' })).entries.map(value => value.id), [local.id]);
});

test('removing context consent also erases the corresponding hashed window cursor', async () => {
  const f = fixture(); await f.enable([EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  await f.ledger.ingest(windowSnapshot());
  assert.equal(f.store.global.cursor.kind, 'window');
  await f.ledger.configure({ contextApplications: [] });
  assert.equal(f.store.global.cursor, null);
  assert.equal([...f.store.rows.values()][0].kind, 'application');
});

test('removing a dynamic app clears its rows and automatically intersects its additional consent', async () => {
  const f = fixture(); await f.enable([WORD, EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  await f.ledger.ingest(snapshot('/allowed/report.docx')); f.clock(START + 1);
  await f.ledger.ingest(windowSnapshot());
  await f.ledger.configure({ applications: [WORD] });
  assert.deepEqual(f.ledger.getSettings().contextApplications, []);
  assert.equal(f.store.rows.size, 1); assert.equal([...f.store.rows.values()][0].kind, 'document');
  assert.equal(f.store.global.cursor, null); assert.doesNotMatch(f.json(), /edgemac|季度|example\.com/);
});

test('window transitions deduplicate canonical query/hash changes but not a different title or URL', async () => {
  const f = fixture(); await f.enable([EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  await f.ledger.ingest(windowSnapshot());
  assert.equal((await f.ledger.ingest(windowSnapshot(EDGE, { title: '季度计划🧭', url: 'https://example.com/docs/plan?changed=1#other' }))).reason, 'duplicate');
  f.clock(START + 1);
  assert.equal((await f.ledger.ingest(windowSnapshot(EDGE, { title: 'New title', url: 'https://example.com/docs/plan' }))).recorded, true);
  f.clock(START + 2);
  assert.equal((await f.ledger.ingest(windowSnapshot(EDGE, { title: 'New title', url: 'https://example.com/docs/other' }))).recorded, true);
  assert.equal(f.store.rows.size, 3); assert.equal(f.checks.length, 0);
});

test('app-only queries project before document/window schema validation and never touch opaque metadata', async () => {
  const f = fixture(); await f.enable([WORD, EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  let reads = 0;
  const opaque = Object.defineProperty({}, 'title', { enumerable: true, get() { reads++; throw new Error('PRIVATE TITLE'); } });
  const window = windowEntry({ window: opaque }), invalidDocument = storedEntry({ file: '/allowed/PRIVATE.docx' });
  invalidDocument.document = { body: 'PRIVATE BODY', modifiedAt: 'invalid' };
  f.store.rows.set(window.id, window); f.store.rows.set(invalidDocument.id, invalidDocument);
  f.table.entries = function* () { for (const pair of f.store.rows) yield pair; };
  const result = await f.ledger.list({ kind: 'application' });
  assert.equal(result.matchedCount, 2); assert.equal(result.entries.length, 2);
  assert.equal((await f.ledger.list({ kind: 'application', query: 'PRIVATE' })).matchedCount, 0);
  assert.equal(reads, 0); assert.equal(f.checks.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|title|window|document|body/);
  assert.equal(f.store.calls.filter(([name]) => name === 'put').length, 0);
});

test('entry lookup revalidates retained IDs/selection/context and sanitizes persisted URLs on read', async () => {
  const f = fixture(); await f.enable([EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  const row = (await f.ledger.ingest(windowSnapshot())).entry;
  f.store.rows.get(row.id).window.url = 'HTTPS://EXAMPLE.com/docs/plan?secret=PRIVATE#PRIVATE';
  const read = await f.ledger.entry(row.id);
  assert.equal(read.window.url, 'https://example.com/docs/plan');
  assert.equal(f.store.rows.get(row.id).window.url, read.window.url);
  read.window.title = 'tampered'; assert.equal((await f.ledger.entry(row.id)).window.title, '季度计划🧭');
  assert.equal(await f.ledger.entry('https://arbitrary.example/'), null);
  assert.equal(await f.ledger.entry(`${row.id}\n`), null);
  assert.equal(await f.ledger.entry(`wa-${randomUUID()}`), null);
  await f.ledger.configure({ enabled: false }); assert.equal((await f.ledger.entry(row.id)).kind, 'window');
  await f.ledger.configure({ contextApplications: [] }); assert.equal((await f.ledger.entry(row.id)).kind, 'application');
  await f.ledger.configure({ applications: [] }); assert.equal(await f.ledger.entry(row.id), null);
  assert.equal(f.checks.length, 0);
});

test('entry lookup rejects expired and future observations and never opens or inspects another document', async () => {
  const f = fixture(); await f.enable([WORD, EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  const local = storedEntry({ file: '/allowed/unrelated.docx' }); f.add(local);
  const expired = windowEntry({ at: START - 7 * DAY }), future = windowEntry({ at: START + 1 }); f.add(expired); f.add(future);
  assert.equal(await f.ledger.entry(expired.id), null); assert.equal(await f.ledger.entry(future.id), null);
  assert.equal(f.store.rows.has(expired.id), false); assert.equal(f.store.rows.has(future.id), false);
  assert.equal(f.checks.length, 0);
});

test('window retention uses the same 1000-row seven-day ceiling as app and document observations', async () => {
  const f = fixture({ settings: { enabled: false, applications: [EDGE], contextApplications: [EDGE] } });
  for (let n = 0; n < MAX_ACTIVITY_ENTRIES + 3; n++) f.add(windowEntry({ at: START - n, window: { title: `Window ${n}` } }));
  const result = await f.ledger.list({ kind: 'document', limit: 20 });
  assert.equal(result.matchedCount, MAX_ACTIVITY_ENTRIES); assert.equal(result.entries.length, 20); assert.equal(f.store.rows.size, MAX_ACTIVITY_ENTRIES);
  f.clock(START + 7 * DAY); await f.ledger.purge();
  assert.equal(f.store.rows.size, 0); assert.equal(f.checks.length, 0);
});

for (const phase of ['put', 'cursor']) test(`context revocation compensates a dispatched uncancellable window ${phase} write`, { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  const started = deferred(), release = deferred();
  if (phase === 'put') f.store.hooks.put = () => { started.resolve(); return release.promise; };
  else f.store.hooks.set = value => { if (value.cursor?.kind === 'window') { started.resolve(); return release.promise; } };
  const writing = f.ledger.ingest(windowSnapshot()); await started.promise;
  const revoke = f.ledger.configure({ contextApplications: [] });
  assert.deepEqual(f.ledger.getSettings().contextApplications, []);
  release.resolve(); await revoke;
  assert.equal((await writing).recorded, false); assert.equal(f.store.rows.size, 0);
  assert.deepEqual(f.store.global.settings.contextApplications, []); assert.equal(f.store.global.cursor, null);
});

test('context revocation aborts a pending document validation without preserving its window fallback', { timeout: 2000 }, async () => {
  const started = deferred(), late = deferred();
  const f = fixture({ validate: () => { started.resolve(); return late.promise; } }); await f.enable([WORD]); await f.ledger.configure({ contextApplications: [WORD] });
  const writing = f.ledger.ingest(windowSnapshot(WORD, { title: 'PRIVATE WINDOW', url: 'https://example.com/private' }, '/allowed/report.docx')); await started.promise;
  await f.ledger.configure({ contextApplications: [] });
  assert.equal((await writing).recorded, false);
  late.resolve(document()); await flush(); assert.equal(f.store.rows.size, 0);
  f.validator(file => document(file));
  assert.equal((await f.ledger.ingest(snapshot('/allowed/report.docx'))).entry.kind, 'document', 'old root consent remains valid');
  assert.doesNotMatch(f.json(), /PRIVATE WINDOW|example\.com/);
});

for (const action of ['abort', 'dispose']) test(`a late context consent expansion rolls back on ${action}, including after reopen`, { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([EDGE]); const caller = new AbortController(), started = deferred(), release = deferred();
  f.store.hooks.set = value => { if (value.settings.contextApplications.includes(EDGE)) { started.resolve(); return release.promise; } };
  const changing = f.ledger.configure({ contextApplications: [EDGE] }, caller.signal);
  const rejected = assert.rejects(changing);
  await started.promise;
  assert.deepEqual(f.ledger.getSettings().contextApplications, [], 'not effective until durable');
  let disposing;
  if (action === 'abort') caller.abort(new Error('caller stopped')); else disposing = f.ledger.dispose();
  release.resolve(); await rejected; await disposing;
  assert.deepEqual(f.store.global.settings.contextApplications, []);
  f.store.hooks.set = undefined;
  const reopened = f.make(); assert.deepEqual(reopened.getSettings().contextApplications, []); await reopened.dispose();
  assert.equal(f.store.rows.size, 0);
});

test('a cancelled context expansion cannot be inherited by a queued partial settings change', { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([EDGE]); const caller = new AbortController(), started = deferred(), release = deferred();
  f.store.hooks.set = value => { if (value.settings.contextApplications.includes(EDGE)) { started.resolve(); return release.promise; } };
  const expansion = f.ledger.configure({ contextApplications: [EDGE] }, caller.signal), rejected = assert.rejects(expansion);
  await started.promise;
  const pause = f.ledger.configure({ enabled: false }); caller.abort(); release.resolve();
  await rejected; await pause;
  assert.deepEqual(f.store.global.settings, { enabled: false, applications: [EDGE], retentionDays: 7, contextApplications: [] });
});

test('a context grant depending on a rolled-back app expansion is rejected rather than silently enabled', { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([WORD]); const caller = new AbortController(), started = deferred(), release = deferred();
  f.store.hooks.set = value => { if (value.settings.applications.includes(EDGE)) { started.resolve(); return release.promise; } };
  const selection = f.ledger.configure({ applications: [WORD, EDGE] }, caller.signal), rejected = assert.rejects(selection);
  await started.promise;
  const grant = f.ledger.configure({ contextApplications: [EDGE] });
  const rejectedGrant = assert.rejects(grant, { code: 'INVALID_ACTIVITY_INPUT' });
  caller.abort(); release.resolve(); await rejected; await rejectedGrant;
  assert.deepEqual(f.store.global.settings.applications, [WORD]); assert.deepEqual(f.store.global.settings.contextApplications, []);
});

test('a queued context re-grant does not undo the synchronous revocation fence while storage drains', { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  const started = deferred(), release = deferred();
  f.store.hooks.set = value => { if (!value.settings.contextApplications.length) { started.resolve(); return release.promise; } };
  const revoke = f.ledger.configure({ contextApplications: [] }); await started.promise;
  const grant = f.ledger.configure({ contextApplications: [EDGE] });
  assert.deepEqual(f.ledger.getSettings().contextApplications, []);
  const observation = f.ledger.ingest(windowSnapshot());
  release.resolve(); await revoke; await grant;
  const result = await observation;
  assert.equal(result.entry.kind, 'application', 'a sample taken before re-grant durability cannot include window metadata');
  assert.doesNotMatch(f.json(), /季度|example\.com/);
});

test('a pending contextual entry read cannot return metadata after its consent is revoked', { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  const row = (await f.ledger.ingest(windowSnapshot())).entry;
  f.store.rows.get(row.id).window.url += '?secret=PRIVATE';
  const started = deferred(), release = deferred();
  f.store.hooks.put = () => { started.resolve(); return release.promise; };
  const reading = f.ledger.entry(row.id); await started.promise;
  const revoke = f.ledger.configure({ contextApplications: [] });
  release.resolve(); await revoke;
  assert.equal(await reading, null);
  assert.equal(f.store.rows.get(row.id).kind, 'application'); assert.doesNotMatch(f.json(), /季度|example\.com|PRIVATE/);
});

test('window clear tombstones survive recreation without retaining plaintext title or URL', async () => {
  const f = fixture(); await f.enable([EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  await f.ledger.ingest(windowSnapshot()); await f.ledger.clear(); await f.ledger.dispose();
  assert.doesNotMatch(f.json(), /季度|example\.com|PRIVATE/);
  const reopened = f.make();
  assert.equal((await reopened.ingest(windowSnapshot())).reason, 'duplicate');
  assert.equal(f.store.rows.size, 0);
  assert.equal((await reopened.ingest(windowSnapshot(EDGE, { title: 'New window' }))).recorded, true);
  await reopened.dispose();
});

for (const phase of ['document-validation', 'window-normalization-write']) test(`entry cannot extend an observed ID lifetime across a pending ${phase}`, { timeout: 2000 }, async () => {
  const f = fixture(); await f.enable([WORD, EDGE]); await f.ledger.configure({ contextApplications: [EDGE] });
  const row = phase === 'document-validation' ? storedEntry({ file: '/allowed/report.docx' }) : windowEntry();
  f.add(row); f.clock(START + 7 * DAY - 1);
  const started = deferred(), release = deferred();
  if (phase === 'document-validation') f.validator(() => { started.resolve(); return release.promise; });
  else {
    f.store.rows.get(row.id).window.url += '?secret=PRIVATE';
    f.store.hooks.put = () => { started.resolve(); return release.promise; };
  }
  const reading = f.ledger.entry(row.id); await started.promise;
  f.clock(START + 7 * DAY); release.resolve(document());
  assert.equal(await reading, null);
  await f.ledger.purge(); assert.equal(f.store.rows.has(row.id), false);
});
