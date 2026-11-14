import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ActivityActionSchema, ActivityInvocation, ActivityResultSchema } from '../lib/activity-rpc.js';

// This executes only production pure helpers. It never creates React elements,
// installs a mock renderer, opens a browser, or invokes the Host/OS/voice/Agent.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const begin = source.indexOf('// BEGIN_WORKFILES_PURE');
const end = source.indexOf('// END_WORKFILES_PURE');
assert.ok(begin >= 0 && end > begin);
// The same realm keeps the production plain-object guard intact when one pure
// helper calls another. Only this marked helper block executes, never the factory.
const helpers = vm.runInThisContext(`(() => { ${source.slice(begin, end)}\nreturn { applications, maxApplications, isApplicationId, parseActionInput, updateApplicationSelection, updateContextSelection, copyPolicySettings, initialPolicyState, reducePolicyState, canWritePolicy, mergeApplicationCatalog, filterApplicationCatalog, applicationRows, observedOpenAction, parseActivityResult, makeActivityContribution, decodeActivityResponse, shortcutLabel, voiceBusy, voiceInProgress, watchVoiceStatus, focusIndex, formatObserved, createViewStore }; })()`, { timeout: 1000 });
const clone = value => JSON.parse(JSON.stringify(value));
const word = 'com.microsoft.Word', ppt = 'com.microsoft.Powerpoint', wps = 'com.kingsoft.wpsoffice.mac', edge = 'com.microsoft.edgemac', textEdit = 'com.apple.TextEdit';
const rowId = 'wa-12345678-1234-4abc-8def-123456789abc';

test('client public contribution matches the authoritative Host descriptor', () => {
  const contribution = helpers.makeActivityContribution();
  assert.equal(contribution.package, '@local/deepseek-workfiles/activity');
  assert.equal(contribution.descriptors.length, 1);
  const client = contribution.descriptors[0];
  for (const key of ['id', 'service', 'namespace', 'method']) assert.equal(client[key], ActivityInvocation[key]);
  assert.deepEqual(clone(client.invocation), clone(ActivityInvocation.invocation));
  assert.deepEqual(clone(client.cancellation), clone(ActivityInvocation.cancellation));
  assert.equal(client.parameters.length, ActivityInvocation.parameters.length);
  assert.deepEqual(clone(client.parameters.map(({ name, wire, source, codec }) => ({ name, wire, source, mode: codec.mode, typeSymbol: codec.typeSymbol }))), clone(ActivityInvocation.parameters.map(({ name, wire, source, codec }) => ({ name, wire, source, mode: codec.mode, typeSymbol: codec.typeSymbol }))));
  assert.equal(client.result.mode, 'strict');
  assert.equal(client.result.typeSymbol, ActivityInvocation.result.typeSymbol);
  assert.equal(typeof client.result.create().parse, 'function');
});

const validInputs = [
  { action: 'status' }, { action: 'status', refresh: true },
  { action: 'configure', applications: [] }, { action: 'configure', applications: [word, ppt, wps] },
  { action: 'configure', applications: [edge, textEdit, 'cn.example.Work-App_2'] },
  { action: 'configure', contextApplications: [] }, { action: 'configure', contextApplications: [edge] },
  { action: 'configure', applications: [word, edge], contextApplications: [edge] },
  { action: 'configure', enabled: false }, { action: 'configure', enabled: true, applications: [word], contextApplications: [] },
  { action: 'discover_applications' }, { action: 'open_observed', id: rowId },
  { action: 'list', query: '报告', limit: 20, after: '2026-11-12T00:00:00+08:00', before: '2026-11-14T00:00:00+08:00' },
  { action: 'clear' }, { action: 'open_accessibility' }, { action: 'folders' },
  { action: 'add_root', path: '/Users/demo/Work reports' }, { action: 'remove_root', path: '/Users/demo/Work reports' },
  { action: 'set_search_enabled', enabled: false }, { action: 'voice_status' }, { action: 'voice_show' },
  { action: 'voice_record' }, { action: 'voice_cancel' }, { action: 'voice_shortcut', shortcut: 'CommandOrControl+Shift+Space' },
];
for (const input of validInputs) test(`client and Host accept ${input.action} ${Object.keys(input).slice(1).join(',')}`, () => {
  const output = helpers.parseActionInput(input);
  assert.deepEqual(clone(output), input);
  assert.deepEqual(ActivityActionSchema.parse(output), input);
});

test('selection parsing never adds enabled or legacy metadata consent and clones both arrays', () => {
  const legacy = { action: 'configure', applications: [word, ppt] };
  const parsedLegacy = helpers.parseActionInput(legacy);
  assert.equal(Object.hasOwn(parsedLegacy, 'enabled'), false);
  assert.equal(Object.hasOwn(parsedLegacy, 'contextApplications'), false);
  parsedLegacy.applications.push(edge);
  assert.deepEqual(legacy.applications, [word, ppt]);
  const sameArray = [word];
  const result = helpers.parseActionInput({ action: 'configure', applications: sameArray, contextApplications: sameArray });
  assert.notEqual(result.applications, sameArray);
  assert.notEqual(result.contextApplications, sameArray);
  assert.notEqual(result.applications, result.contextApplications);
  result.applications.push(ppt); result.contextApplications.length = 0;
  assert.deepEqual(sameArray, [word]);
});

test('Office apps are suggestions; any explicitly selected valid bundle ID is accepted', () => {
  assert.deepEqual(clone(helpers.applications).map(app => app.id), [word, ppt, wps]);
  assert.equal(helpers.maxApplications, 128);
  for (const id of [edge, textEdit, 'com.example.Work-App_2', 'a.b', `${'a'.repeat(253)}.b`]) {
    assert.equal(helpers.isApplicationId(id), true, id);
    const action = { action: 'configure', applications: [id], contextApplications: [id] };
    assert.deepEqual(clone(helpers.parseActionInput(action)), action);
    assert.deepEqual(ActivityActionSchema.parse(action), action);
  }
  const ids = Array.from({ length: 128 }, (_, i) => `com.example.App${i}`);
  assert.deepEqual(clone(helpers.parseActionInput({ action: 'configure', applications: ids, contextApplications: ids })), { action: 'configure', applications: ids, contextApplications: ids });
  assert.equal(ActivityActionSchema.safeParse({ action: 'configure', applications: ids, contextApplications: ids }).success, true);
});

test('both app arrays retain Host strictness for duplicates, caps, controls, paths and non-IDs', () => {
  const ids = Array.from({ length: 129 }, (_, i) => `com.example.App${i}`);
  const invalidLists = [null, word, [word, word], [null], [1], ['other'], [''], ['com..example'], ['.com.example'], ['com.example.'],
    [' com.example.App'], ['com.example.App '], ['com.example/App'], ['/Applications/App.app'], ['file:///Applications/App.app'],
    ['com.example.App\n'], ['com.example.App\r'], ['com.example.App\u0085'], ['com.example.文档'], ['com.example.App\u2028'],
    [`${'a'.repeat(254)}.b`], Array(1), ids];
  for (const field of ['applications', 'contextApplications']) for (const list of invalidLists) {
    const action = { action: 'configure', [field]: list };
    assert.throws(() => helpers.parseActionInput(action), `${field}: ${String(list)}`);
    assert.equal(ActivityActionSchema.safeParse(action).success, false, `${field}: ${String(list)}`);
  }
  for (const code of [0, 9, 10, 13, 31, 127, 128, 159]) {
    const id = `com.example.App${String.fromCharCode(code)}`;
    assert.equal(helpers.isApplicationId(id), false);
  }
});

test('metadata must be a subset when both arrays are supplied; context-only updates defer to Host state', () => {
  for (const action of [
    { action: 'configure', applications: [], contextApplications: [edge] },
    { action: 'configure', applications: [word], contextApplications: [edge] },
    { action: 'configure', applications: [word], contextApplications: [word, ppt] },
  ]) {
    assert.throws(() => helpers.parseActionInput(action));
    assert.equal(ActivityActionSchema.safeParse(action).success, false);
  }
  const contextOnly = { action: 'configure', contextApplications: [edge] };
  assert.deepEqual(clone(helpers.parseActionInput(contextOnly)), contextOnly);
  assert.deepEqual(ActivityActionSchema.parse(contextOnly), contextOnly);
});

test('app selection sends one identity and preserves legacy enabled state and metadata consent', () => {
  const added = helpers.updateApplicationSelection(edge, true);
  assert.deepEqual(clone(added), { action: 'set_application', id: edge, selected: true });
  const removed = helpers.updateApplicationSelection(word, false);
  assert.deepEqual(clone(removed), { action: 'set_application', id: word, selected: false });
  for (const value of [added, removed]) {
    assert.equal(Object.hasOwn(value, 'enabled'), false);
    assert.equal(Object.hasOwn(value, 'applications'), false);
    assert.equal(Object.hasOwn(value, 'contextApplications'), false);
    assert.deepEqual(ActivityActionSchema.parse(clone(value)), clone(value));
  }
  // Removing the last app is the Host's atomic revoke-and-pause; the Client never
  // invents an enabling field or a replacement selection.
  const selected = Object.freeze([word, ppt]);
  assert.equal(selected.includes(edge), false);
});

test('only an explicit metadata checkbox can add consent, and it never reselects or enables', () => {
  const optedIn = helpers.updateContextSelection(edge, true);
  assert.deepEqual(clone(optedIn), { action: 'set_context', id: edge, allowed: true });
  const revoked = helpers.updateContextSelection(word, false);
  assert.deepEqual(clone(revoked), { action: 'set_context', id: word, allowed: false });
  for (const value of [optedIn, revoked]) {
    assert.equal(Object.hasOwn(value, 'enabled'), false);
    assert.equal(Object.hasOwn(value, 'applications'), false);
    assert.equal(Object.hasOwn(value, 'contextApplications'), false);
    assert.deepEqual(ActivityActionSchema.parse(clone(value)), clone(value));
  }
  for (const helper of [helpers.updateApplicationSelection, helpers.updateContextSelection]) {
    assert.throws(() => helper('/Applications/Other.app', true), /explicit application permission change/u);
    assert.throws(() => helper(word, 'yes'), /Expected a boolean/u);
    assert.throws(() => helper(`${word}\n`, true), /explicit application permission change/u);
    assert.throws(() => helper(`${word}\r`, true), /explicit application permission change/u);
    assert.throws(() => helper(`${word}\u2028`, true), /explicit application permission change/u);
  }
});

test('authoritative status gates policy writes, and an acknowledged setting never unlocks them early', () => {
  const status = applications => ({ ledger: { settings: { enabled: true, applications, contextApplications: applications, retentionDays: 7 }, state: 'recording' }, documents: { enabled: true }, voice: null });
  let policy = helpers.initialPolicyState();
  // Nothing is writable before the first authoritative read.
  assert.equal(policy.stale, true);
  assert.equal(helpers.canWritePolicy(policy, true), false);
  assert.equal(helpers.canWritePolicy(policy, false), false);
  policy = helpers.reducePolicyState(policy, { type: 'status', value: status([word, edge]) });
  assert.equal(policy.stale, false);
  assert.equal(helpers.canWritePolicy(policy, true), true);
  assert.equal(helpers.canWritePolicy(policy, true, true), false, 'a pending operation also blocks a second write');
  assert.equal(helpers.canWritePolicy(policy, false), false, 'no Owner access means no write');
  // Starting a write locks the gate synchronously, before the reply arrives.
  policy = helpers.reducePolicyState(policy, { type: 'writing' });
  assert.equal(helpers.canWritePolicy(policy, true), false);
  // The acknowledgment replaces the displayed policy with the Host's own result,
  // and removing an app never restores it from a stale Client list.
  policy = helpers.reducePolicyState(policy, { type: 'ack', value: { settings: { enabled: true, applications: [edge], contextApplications: [], retentionDays: 7 } } });
  assert.deepEqual(policy.status.ledger.settings.applications, [edge]);
  assert.deepEqual(policy.status.ledger.settings.contextApplications, []);
  assert.equal(policy.stale, true); assert.equal(helpers.canWritePolicy(policy, true), false);
  // A failed confirmation keeps the write gate shut instead of silently reviving old checkboxes.
  policy = helpers.reducePolicyState(policy, { type: 'failed', error: new Error('ledger unavailable') });
  assert.equal(policy.stale, true); assert.match(policy.error, /ledger unavailable/u);
  assert.equal(helpers.canWritePolicy(policy, true), false);
  // Only a fresh authoritative status reopens writes.
  policy = helpers.reducePolicyState(policy, { type: 'status', value: status([edge]) });
  assert.equal(policy.stale, false); assert.equal(policy.error, ''); assert.equal(helpers.canWritePolicy(policy, true), true);
});

test('legacy policy state without context consent copies as empty and never widens it', () => {
  const copied = helpers.copyPolicySettings({ enabled: true, applications: [word, ppt], retentionDays: 7 });
  assert.deepEqual(clone(copied), { enabled: true, applications: [word, ppt], contextApplications: [], retentionDays: 7 });
  assert.throws(() => helpers.copyPolicySettings({ enabled: true, applications: [word], contextApplications: [edge], retentionDays: 7 }));
  assert.throws(() => helpers.copyPolicySettings({ enabled: 'yes', applications: [word], contextApplications: [] }));
  for (const value of [{}, null, { enabled: true, applications: [word], retentionDays: 30 }]) assert.throws(() => helpers.copyPolicySettings(value));
  // Malformed authoritative replies are rejected rather than half-applied.
  assert.throws(() => helpers.reducePolicyState(helpers.initialPolicyState(), { type: 'status', value: { ledger: {}, documents: {} } }));
  assert.throws(() => helpers.reducePolicyState(helpers.initialPolicyState(), { type: 'unknown' }));
});

test('catalog merges discovery, capabilities, saved identities and retained row labels without selecting them', () => {
  const savedOnly = 'org.example.Uninstalled', retainedOnly = 'org.example.Retained';
  const input = {
    selected: [savedOnly, word],
    capabilities: [{ id: word, name: 'Word status', installed: true }, { id: savedOnly, name: 'Saved editor', installed: false }],
    discovered: [{ id: edge, name: 'Microsoft Edge', installed: true, running: true }, { id: word, name: 'Microsoft Word', installed: true, running: true }, { id: '/Applications/Bad.app', name: 'Bad' }],
    retained: [{ id: retainedOnly, name: 'Previously seen editor', installed: true, running: true }],
    entries: [{ app: { id: textEdit, name: '<Title-like app label>' } }],
  };
  const before = clone(input), catalog = helpers.mergeApplicationCatalog(input);
  assert.deepEqual(input, before);
  assert.equal(catalog.truncated, false);
  assert.equal(new Set(catalog.applications.map(app => app.id)).size, catalog.applications.length);
  assert.equal(catalog.applications.find(app => app.id === word).name, 'Microsoft Word');
  assert.equal(catalog.applications.find(app => app.id === edge).running, true);
  assert.equal(catalog.applications.find(app => app.id === savedOnly).installed, false);
  assert.equal(catalog.applications.find(app => app.id === textEdit).name, '<Title-like app label>');
  assert.equal(catalog.applications.find(app => app.id === retainedOnly).name, 'Previously seen editor');
  assert.equal(Object.hasOwn(catalog.applications.find(app => app.id === retainedOnly), 'running'), false);
  assert.equal(catalog.applications.some(app => app.name === 'Bad'), false);
  assert.deepEqual(input.selected, [savedOnly, word]);
  assert.equal(Object.hasOwn(catalog, 'contextApplications'), false);
  const vanished = helpers.mergeApplicationCatalog({ selected: [savedOnly], discovered: [], capabilities: [], retained: catalog.applications });
  assert.equal(vanished.applications.find(app => app.id === savedOnly).name, 'Saved editor');
  assert.equal(Object.hasOwn(vanished.applications.find(app => app.id === edge), 'running'), false);
  assert.equal(helpers.mergeApplicationCatalog({ selected: ['org.example.Unknown'] }).applications.find(app => app.id === 'org.example.Unknown').name, 'org.example.Unknown');
});

test('catalog is sorted and bounded to 128 without evicting any saved selection', () => {
  const selected = ['org.zzz.SavedOnly', 'org.zzz.SavedTwo'];
  const discovered = Array.from({ length: 160 }, (_, i) => ({ id: `com.example.App${i}`, name: `App ${String(i).padStart(3, '0')}`, installed: true, running: true }));
  const catalog = helpers.mergeApplicationCatalog({ selected, discovered });
  assert.equal(catalog.applications.length, 128); assert.equal(catalog.truncated, true);
  for (const id of selected) assert.equal(catalog.applications.some(app => app.id === id), true);
  const overlapping = helpers.mergeApplicationCatalog({ selected: ['com.example.App0', 'com.example.App1'], discovered });
  assert.equal(overlapping.applications.length, 128, 'reserved IDs already in the sorted catalog do not consume a second slot');
  const sorted = [...catalog.applications].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  assert.deepEqual(catalog.applications, sorted);
  const allSelected = Array.from({ length: 128 }, (_, i) => `org.saved.App${i}`);
  const full = helpers.mergeApplicationCatalog({ selected: allSelected, discovered });
  assert.equal(full.applications.length, 128);
  assert.deepEqual(full.applications.map(app => app.id).sort(), [...allSelected].sort());
  assert.deepEqual(helpers.filterApplicationCatalog(catalog.applications, ' SAVEDonly ').map(app => app.id), ['org.zzz.SavedOnly']);
  assert.equal(helpers.filterApplicationCatalog(catalog.applications, 'App 000')[0].id, 'com.example.App0');
  assert.equal(helpers.filterApplicationCatalog(catalog.applications, 'no such app').length, 0);
  assert.equal(catalog.applications.length, 128);
});

test('observation opening sends a strict stored ID only and is disabled without Owner, URL, search or idle operation', () => {
  const entry = { id: rowId, kind: 'window', app: { id: edge, name: 'Microsoft Edge' }, window: { title: '<img src=x onerror=evil()>', url: 'https://example.com/observed' } };
  const allowed = { canAct: true, busy: false, searchEnabled: true };
  const action = helpers.observedOpenAction(entry, allowed);
  assert.deepEqual(clone(action), { action: 'open_observed', id: rowId });
  assert.deepEqual(ActivityActionSchema.parse(action), action);
  assert.equal(Object.hasOwn(action, 'url'), false); assert.equal(Object.hasOwn(action, 'title'), false);
  assert.equal(helpers.observedOpenAction(entry), null);
  for (const blocked of [{ canAct: false }, { busy: true }, { searchEnabled: false }, { searchEnabled: undefined }]) assert.equal(helpers.observedOpenAction(entry, { ...allowed, ...blocked }), null);
  for (const badEntry of [null, { ...entry, kind: 'application' }, { ...entry, kind: 'document' }, { ...entry, id: `${rowId}\n` },
    { ...entry, window: { title: 'A title without a URL' } }, { ...entry, window: {} },
    { ...entry, window: { url: 'http://example.com/unsafe' } }, { ...entry, window: { url: 'javascript:evil()' } },
    { ...entry, window: { url: 'https://example.com/unsafe\n' } }]) assert.equal(helpers.observedOpenAction(badEntry, allowed), null);
});

test('new actions reject arbitrary URLs, paths, forged IDs, discovery parameters and trailing controls', () => {
  for (const input of [
    { action: 'discover_applications', automatic: true }, { action: 'discover_applications', applications: [word] },
    { action: 'open_observed' }, { action: 'open_observed', id: 'wa-test' }, { action: 'open_observed', id: rowId.toUpperCase() },
    { action: 'open_observed', id: `${rowId}\n` }, { action: 'open_observed', id: `${rowId}\r` }, { action: 'open_observed', id: `${rowId}\u0085` },
    { action: 'open_observed', id: 'https://example.com' }, { action: 'open_observed', id: '/Users/demo/file' },
    { action: 'open_observed', id: rowId, url: 'https://example.com' }, { action: 'open_observed', id: rowId, appId: edge },
  ]) {
    assert.throws(() => helpers.parseActionInput(input));
    assert.equal(ActivityActionSchema.safeParse(input).success, false);
  }
});

test('strict action boundaries reject foreign fields and spoofed authority', () => {
  for (const input of [null, [], 'status', {}, { action: 'constructor' }, { action: '__proto__' }, { action: 'enable_all' },
    { action: 'status', principal: { kind: 'owner' } }, { action: 'configure', roots: ['/'] },
    { action: 'list', enabled: true }, { action: 'voice_record', sessionId: 'other-session' },
    JSON.parse('{"action":"status","__proto__":{"kind":"owner"}}')]) assert.throws(() => helpers.parseActionInput(input));
});

test('boundaries enforce primitive types, bounded filters, time zones and record limits', () => {
  for (const input of [
    { action: 'status', refresh: 'yes' }, { action: 'configure', enabled: 1 }, { action: 'configure', applications: word },
    { action: 'list', query: 'x'.repeat(513) }, { action: 'list', query: null },
    { action: 'list', limit: 0 }, { action: 'list', limit: 21 }, { action: 'list', limit: 1.5 },
    { action: 'list', after: '2026-11-13' }, { action: 'list', before: '2026-11-13T08:00:00' },
    { action: 'add_root', path: '' }, { action: 'remove_root', path: '/Users/demo/secret\nname' },
    { action: 'add_root', path: 'x'.repeat(4097) }, { action: 'set_search_enabled' },
    { action: 'voice_shortcut', shortcut: '\0bad' }, { action: 'voice_shortcut', shortcut: 'x'.repeat(101) },
  ]) assert.throws(() => helpers.parseActionInput(input), input.action);
});

test('Activity RemoteResult decoding is not the old CommandExecution wrapper', () => {
  const data = { settings: { enabled: false, applications: [], retentionDays: 7 } };
  assert.deepEqual(helpers.decodeActivityResponse({ ok: true, value: { ok: true, data } }, 'fallback'), data);
  assert.throws(() => helpers.decodeActivityResponse({ ok: true, value: { result: { kind: 'success', text: '{"ok":true}' } } }, 'fallback'));
  assert.throws(() => helpers.decodeActivityResponse({ ok: false, error: { message: 'permission denied' } }, 'fallback'), /permission denied/u);
  assert.throws(() => helpers.decodeActivityResponse({ ok: false, error: { code: 'gateway/cancelled' } }, 'fallback'), /gateway\/cancelled/u);
  assert.throws(() => helpers.decodeActivityResponse(undefined, 'fallback'), /fallback/u);
});

test('result codec accepts bounded JSON records and rejects absence, unsafe types and cycles', () => {
  const valid = { ok: true, data: { entries: [{ id: 'wa-test', kind: 'application', app: { id: word, name: 'Microsoft Word' }, observedAt: '2026-11-13T16:00:00.000Z' }], retentionDays: 7 } };
  assert.equal(helpers.parseActivityResult(valid), valid);
  assert.deepEqual(ActivityResultSchema.parse(valid), valid);
  const windowData = { ok: true, data: { entries: [{ id: rowId, kind: 'window', app: { id: edge, name: 'Microsoft Edge' }, window: { title: '<private title>', url: 'https://example.com/observed' }, observedAt: '2026-11-14T00:00:00.000Z' }], retentionDays: 7 } };
  assert.equal(helpers.parseActivityResult(windowData), windowData);
  assert.deepEqual(ActivityResultSchema.parse(windowData), windowData);
  const discovered = { ok: true, data: { applications: [{ id: edge, name: 'Microsoft Edge', installed: true, running: true }], truncated: false } };
  assert.equal(helpers.parseActivityResult(discovered), discovered);
  assert.deepEqual(ActivityResultSchema.parse(discovered), discovered);
  const cycle = {}; cycle.self = cycle;
  const sparse = Array(2);
  for (const value of [undefined, { ok: true }, { ok: false, data: null }, { ok: true, data: undefined },
    { ok: true, data: Infinity }, { ok: true, data: NaN }, { ok: true, data: 1n },
    { ok: true, data: () => {} }, { ok: true, data: new Date() }, { ok: true, data: cycle },
    { ok: true, data: sparse }, { ok: true, data: { a: Symbol('x') } },
    { ok: true, data: {}, extra: 'not a business result' }, { ok: true, data: 'x'.repeat(262144) },
  ]) assert.throws(() => helpers.parseActivityResult(value));
});

test('result JSON budget also rejects excessive nesting and node count', () => {
  let nested = null;
  for (let i = 0; i < 34; i++) nested = { child: nested };
  assert.throws(() => helpers.parseActivityResult({ ok: true, data: nested }));
  assert.throws(() => helpers.parseActivityResult({ ok: true, data: Array(30000).fill(null) }));
});

test('shortcut labels are display-only and busy phases never mean microphone active', () => {
  assert.equal(helpers.shortcutLabel('CommandOrControl+Shift+Space', 'darwin'), '⌘⇧Space');
  assert.equal(helpers.shortcutLabel('CommandOrControl+Shift+Space', 'linux'), 'Ctrl⇧Space');
  assert.equal(helpers.shortcutLabel(null), '⌘⇧Space');
  assert.equal(helpers.voiceBusy({ phase: 'working', microphoneActive: false }), true);
  assert.equal(helpers.voiceBusy({ phase: 'ready', active: { busy: true } }), true);
  assert.equal(helpers.voiceBusy({ phase: 'listening', microphoneActive: false }), false);
  assert.equal(helpers.voiceInProgress({ phase: 'listening' }), true);
  assert.equal(helpers.voiceInProgress({ phase: 'idle', microphoneActive: true }), true);
  assert.equal(helpers.voiceInProgress({ phase: 'done', microphoneActive: false }), false);
});

test('focus traversal wraps only the dialog-owned focusable list', () => {
  assert.equal(helpers.focusIndex(2, 3, false), 0);
  assert.equal(helpers.focusIndex(0, 3, true), 2);
  assert.equal(helpers.focusIndex(-1, 3, false), 0);
  assert.equal(helpers.focusIndex(-1, 3, true), 2);
  assert.equal(helpers.focusIndex(0, 0, false), -1);
});

test('invalid observation dates remain unknown rather than showing a fabricated time', () => {
  assert.equal(helpers.formatObserved(undefined, 'unknown'), 'unknown');
  assert.equal(helpers.formatObserved('not a date', 'unknown'), 'unknown');
  assert.notEqual(helpers.formatObserved('2026-11-13T16:00:00.000Z', 'unknown'), 'unknown');
});

test('shared view state is ephemeral, starts closed and releases subscribers on disposal', () => {
  const store = helpers.createViewStore();
  assert.equal(store.getSnapshot().open, false);
  assert.equal(store.getSnapshot().voice, null);
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  store.open('opaque-user-trigger');
  assert.equal(store.getSnapshot().open, true);
  assert.equal(store.getSnapshot().trigger, 'opaque-user-trigger');
  store.voice({ registered: true });
  assert.equal(store.getSnapshot().voice.registered, true);
  store.close();
  assert.equal(store.getSnapshot().open, false);
  assert.equal(calls, 3);
  unsubscribe(); store.open(); assert.equal(calls, 3);
  store.dispose(); store.open();
  assert.equal(store.getSnapshot().open, false);
  assert.equal(store.getSnapshot().voice, null);
});

test('UI namespaces mount before nested injection; no Session or raw transport workaround', () => {
  assert.ok(source.indexOf('await ctx.remote.$mount(makeActivityContribution())') < source.indexOf("ctx.inject(['remote.workfilesActivity']"));
  assert.match(source, /inject: \['slots', 'locale', 'remote', 'uiWorkspace'\]/u);
  assert.match(source, /childCtx\.remote\.workfilesActivity\.action\(parseActionInput\(input\), signal\)/u);
  assert.doesNotMatch(source, /remote\.commands|commands\.execute|fetch\(|XMLHttpRequest|WebSocket\(|appendChild|createPortal|innerHTML|dangerouslySetInnerHTML|window\.addEventListener|document\.addEventListener/u);
  assert.deepEqual([...source.matchAll(/require\(['"]([^'"]+)['"]\)/gu)].map(match => match[1]), ['react']);
});

test('both entry points open the one owned overlay, preserving atomic composer controls', () => {
  for (const slot of ['conversation.composer.dock', 'sidebar.footer.action', 'shell.overlay']) assert.match(source, new RegExp(`childCtx\\.slots\\.inject\\('${slot.replaceAll('.', '\\.')}'`, 'u'));
  assert.match(source, /className: 'wf-controls'/u);
  assert.match(source, /flex-wrap:nowrap;flex-shrink:0/u);
  assert.match(source, /'aria-modal': true/u);
  assert.match(source, /'aria-haspopup': 'dialog'/u);
  assert.match(source, /event\.key === 'Escape'/u);
  assert.match(source, /restore\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(source, /return \(\) => clearInterval\(timer\)/u);
  assert.match(source, /controller\.quiet = quiet/u);
  assert.match(source, /pending\.current\.abort\(\)/u);
});

test('app and context checkboxes use explicit pure updates and never toggle recording', () => {
  assert.match(source, /updateApplicationSelection\(app\.id, event\.target\.checked\)/u);
  assert.match(source, /updateContextSelection\(app\.id, event\.target\.checked\)/u);
  assert.match(source, /checked: chosen && contextSelected\.includes\(app\.id\), disabled: policyDisabled \|\| !settings \|\| !chosen/u);
  assert.match(source, /contextSelected = settings\?\.contextApplications \|\| \[\]/u);
  assert.doesNotMatch(source, /applications: next, enabled:|!next\.length && settings\?\.enabled/u);
  assert.match(source, /action: 'configure', enabled: !settings\.enabled/u);
  assert.match(source, /已开启：更改软件选择或窗口元数据同意会立即影响/u);
  assert.match(source, /选择软件或窗口元数据不会开启记录/u);
  assert.match(source, /Removing every app pauses recording; no other app is selected automatically/u);
});

test('application discovery is a single explicit button action, never status, opening or polling work', () => {
  const refresh = source.slice(source.indexOf('async function refresh('), source.indexOf('async function discoverApplications('));
  const discover = source.slice(source.indexOf('async function discoverApplications('), source.indexOf('React.useEffect(() => {', source.indexOf('async function discoverApplications(')));
  const polling = source.slice(source.indexOf('React.useEffect(() => {', source.indexOf('async function discoverApplications(')), source.indexOf('async function mutate('));
  assert.doesNotMatch(refresh, /discoverApplications|discover_applications/u);
  assert.doesNotMatch(polling, /discoverApplications|discover_applications/u);
  assert.match(discover, /request\(\{ action: 'discover_applications' \}, signal\)/u);
  assert.doesNotMatch(discover, /action: 'configure'|voice_record|session|Agent|model\./u);
  assert.equal([...source.matchAll(/request\(\{ action: 'discover_applications'/gu)].length, 1);
  assert.equal([...source.matchAll(/=> discoverApplications\(signal\)/gu)].length, 1);
  assert.match(source, /button\(t\('refreshApps'\), signal => discoverApplications\(signal\)/u);
  assert.match(source, /applicationRows\(catalog\.applications, \{ selected, query: appQuery, showBackground \}\)/u);
  assert.doesNotMatch(source, /applications\.map\(app => \{|installed !== true && !selected\.includes/u);
});

test('window titles and addresses render as React text; buttons can request only stored observation IDs', () => {
  const history = source.slice(source.indexOf('const openAction = observedOpenAction('), source.indexOf("t('observedUrlHelp'))),"));
  assert.match(history, /entry\.window\?\.title \|\| t\('windowOnly'\)/u);
  assert.match(history, /h\('div', \{ className: 'wf-record-path' \}, entry\.window\.url\)/u);
  assert.match(history, /observedOpenAction\(entry, \{ canAct, busy: operation\.busy \|\| policy\.stale, searchEnabled: documents\?\.enabled \}\)/u);
  assert.match(history, /request\(openAction, signal\)/u);
  assert.match(history, /disabled: disabled \|\| !openAction/u);
  assert.match(history, /result\?\.status !== 'open_requested'/u);
  assert.match(history, /t\('openRequested'\)/u);
  assert.doesNotMatch(source, /\bhref\s*:|window\.open\(|location\.(?:href|assign)|openExternal|dangerouslySetInnerHTML|innerHTML/u);
  assert.match(source, /不会从标题重建或猜测/u);
  assert.match(source, /不证明编辑、阅读或保存/u);
  assert.match(source, /Query parameters and # fragments are removed/u);
});

test('privacy disclosures separate metadata, folder scope and model conversation; clearing requires confirmation', () => {
  assert.match(source, /confirmClear \? h\('div'/u);
  assert.match(source, /t\('clearConfirm'\)/u);
  assert.match(source, /不读浏览器完整历史、网页／窗口正文或 Codex 历史/u);
  assert.match(source, /不录屏、不记按键、不读剪贴板，空闲不录音/u);
  assert.match(source, /不是全部离线，也不是清空后完全无痕/u);
  assert.match(source, /窗口标题、保存的地址和按需读取的少量文件正文可能进入正常模型对话/u);
  assert.match(source, /窗口标题和 HTTPS 地址不以文件夹为范围/u);
  assert.match(source, /并不是只读系统权限/u);
  assert.match(source, /观察到它在前台出现/u);
  assert.match(source, /1000 条/u);
});

test('Chinese and English dictionaries cover the same UI keys', () => {
  const start = source.indexOf('const dictionaries = ') + 'const dictionaries = '.length;
  const finish = source.indexOf('\n    const css = ', start);
  const literal = source.slice(start, finish).trim().replace(/;$/u, '');
  const dictionaries = vm.runInNewContext(`(${literal})`, {}, { timeout: 1000 });
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
  for (const [, key] of source.matchAll(/\bt\('([^']+)'\)/gu)) assert.equal(typeof dictionaries.zh[key], 'string', key);
});

test('theme, owned aborts and active-aware shortcut guards remain in place without rendering tests', () => {
  const styles = source.slice(source.indexOf('const css = `'), source.indexOf('function icon('));
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\(/iu);
  assert.ok([...styles.matchAll(/var\((--[^),]+)/gu)].every(match => match[1].startsWith('--dsw-alias-')));
  assert.match(source, /lifetime\.abort\(new Error\('Document assistant UI disposed\.'\)\)/u);
  assert.match(source, /AbortSignal\.any\(\[lifetime\.signal, own\.signal/u);
  assert.match(source, /pending\.current\?\.abort\(\)/u);
  assert.match(source, /onKeyDown: keyDown/u);
  assert.match(source, /!voice \|\| voiceInProgress\(voice\), onChange/u);
  assert.match(source, /!voice \|\| voiceInProgress\(voice\) \|\| shortcut\.trim/u);
  assert.match(source, /!voice \|\| voiceInProgress\(voice\), onChange: event => \{ shortcutDirty/u);
});

test('all primary voice gestures use actual native toggle rather than a stale busy decision', () => {
  const composer = source.slice(source.indexOf('function ComposerEntry('), source.indexOf('function SidebarEntry('));
  assert.doesNotMatch(composer, /voice_show|voiceBusy\(state\.voice\)/u);
  assert.match(composer, /action: 'voice_record'/u);
  assert.match(composer, /watchVoiceStatus\(signal => request\(\{ action: 'voice_status' \}/u);
  assert.match(source, /button\(t\('voice'\), async signal => \{ await request\(\{ action: 'voice_record'/u);
  for (const phase of ['ready', 'done', 'error']) {
    assert.equal(helpers.voiceInProgress({ phase, active: { activationId: 'still-visible', busy: false }, microphoneActive: false }), true, phase);
  }
  assert.equal(helpers.voiceInProgress({ phase: 'idle', active: null, microphoneActive: false }), false);
});

test('passive voice status watcher is serial and aborts late results and timers on unmount', async () => {
  const timers = new Map(), values = [], signals = []; let resolve, reads = 0;
  const stop = helpers.watchVoiceStatus(signal => { reads++; signals.push(signal); return new Promise(done => { resolve = done; }); }, value => values.push(value), {
    setTimer(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id; }, clearTimer: id => timers.delete(id),
  });
  assert.equal(reads, 1); assert.equal(timers.size, 0);
  resolve({ phase: 'working' }); await new Promise(done => setImmediate(done));
  assert.deepEqual(values, [{ phase: 'working' }]); assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0]; timers.delete(id); assert.equal(timer.delay, 1500); timer.callback();
  assert.equal(reads, 2); assert.equal(timers.size, 0);
  stop(); stop(); assert.equal(signals[1].aborted, true);
  resolve({ phase: 'listening' }); await new Promise(done => setImmediate(done));
  assert.deepEqual(values, [{ phase: 'working' }]); assert.equal(timers.size, 0);
});

test('hidden or already-aborted status views make no passive request and never retain old status', () => {
  const timers = new Map(), values = []; let reads = 0;
  const options = { setTimer(callback) { const id = Symbol(); timers.set(id, callback); return id; }, clearTimer: id => timers.delete(id) };
  const stop = helpers.watchVoiceStatus(() => { reads++; }, value => values.push(value), { ...options, visible: () => false });
  assert.equal(reads, 0); assert.deepEqual(values, [null]); assert.equal(timers.size, 1); stop(); assert.equal(timers.size, 0);
  const caller = new AbortController(); caller.abort();
  helpers.watchVoiceStatus(() => { reads++; }, value => values.push(value), { ...options, signal: caller.signal });
  assert.equal(reads, 0); assert.equal(timers.size, 0); assert.deepEqual(values, [null]);
});

test('background agents are hidden by default but stay visible once selected', () => {
  const catalog = [
    { id: 'com.apple.dock', name: 'Dock', installed: true, running: true, foreground: false },
    { id: 'com.deepseek.dsh', name: 'DeepSeek Harness', installed: true, running: true, foreground: true },
    { id: 'org.example.Unknown', name: 'org.example.Unknown' },
  ];
  assert.deepEqual(helpers.applicationRows(catalog, { selected: [] }).map(app => app.id), ['com.deepseek.dsh', 'org.example.Unknown']);
  assert.deepEqual(helpers.applicationRows(catalog, { selected: ['com.apple.dock'] }).map(app => app.id), ['com.apple.dock', 'com.deepseek.dsh', 'org.example.Unknown']);
  assert.equal(helpers.applicationRows(catalog, { selected: [], showBackground: true }).length, 3);
  assert.deepEqual(helpers.applicationRows(catalog, { selected: [], query: 'dock' }).map(app => app.id), []);
  assert.deepEqual(helpers.applicationRows(catalog, { selected: [], query: 'dock', showBackground: true }).map(app => app.id), ['com.apple.dock']);
});
