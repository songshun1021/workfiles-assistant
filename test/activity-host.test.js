import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import { installActivityFeature } from '../lib/activity-host.js';
import { ActivityLedgerDomain, APPLICATIONS } from '../lib/activity-ledger.js';

// Public Cordis Context + real feature composition, but fake owned storage,
// subprocess, document engine and OS-open adapter. Never invokes an OS App,
// window, microphone, profile, Agent or model. Static plugin source validation
// by activity-native is the only real filesystem read in the status case.
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const ctx = new Context(), lifetime = new AbortController(), calls = { spawns: [], native: [], folders: [], closes: 0, contributions: [] };
  let state = structuredClone(ActivityLedgerDomain.global.initial), folders = { enabled: true, roots: ['/approved'], configuredRoots: ['/approved'], warnings: [] };
  const rows = new Map(), table = { get: key => structuredClone(rows.get(key)), *entries() { yield* rows; }, async put(key, value) { rows.set(key, structuredClone(value)); }, async deleteMany(keys) { let count = 0; for (const key of keys) count += Number(rows.delete(key)); return count; } };
  ctx.provide('storageDomain', { async open(definition) {
    calls.definition = definition; if (options.failStorage) throw new Error('PRIVATE STORAGE ERROR /profile/secret');
    return { global: { get: () => structuredClone(state), async set(value) { state = structuredClone(value); } }, table: () => table, async close() { calls.closes++; } };
  } });
  ctx.provide('typert', { register(value) { calls.contributions.push(value); return () => {}; } });
  ctx.provide('subprocess', { spawn(spec) {
    calls.spawns.push(spec); let end;
    const done = new Promise(resolve => { end = resolve; });
    const child = { stdout: new PassThrough(), stderr: new PassThrough(), done, waitForExit: async () => { await done; return true; },
      terminate() { child.stdout.end(); child.stderr.end(); end({ exitCode: null, signal: 'SIGTERM' }); } };
    queueMicrotask(() => {
      const action = JSON.parse(spec.argv[4]).action;
      const response = action === 'applications'
        ? { v: 1, platform: 'darwin', source: 'jxa-applicationservices', applications: [{ id: 'com.electron.lark', name: '飞书', installed: true, running: true, foreground: true }], truncated: false }
        : { v: 1, platform: 'darwin', source: 'jxa-applicationservices', available: true, accessibilityTrusted: false, applications: APPLICATIONS.map(app => ({ ...app, installed: true })), reason: 'accessibility_required_for_documents' };
      child.stdout.end(JSON.stringify(response));
      child.stderr.end(); end({ exitCode: 0, signal: null });
    }); return child;
  } });
  if (options.voice) ctx.provide('workfilesVoice', options.voice);
  const combine = caller => AbortSignal.any([lifetime.signal, ...(caller ? [caller] : [])]);
  const feature = await installActivityFeature(ctx, { signal: lifetime.signal, combine,
    readSettings: () => ({ roots: folders.configuredRoots, enabled: folders.enabled }),
    engine: { async status(signal) { signal.throwIfAborted(); return folders; }, async describeObservedDocument() { throw new Error('No observed-document reads allowed by this fixture'); } },
    async configureFolders(input) { calls.folders.push(input); if (input.action === 'set_enabled') folders = { ...folders, enabled: input.enabled }; },
    async native(argv, opts) { opts.signal.throwIfAborted(); calls.native.push(argv); return {}; },
  });
  t.after(async () => { lifetime.abort(); await feature.dispose(); });
  const human = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' }, interactions: 'answer' } } }).get('workfilesActivity');
  await flush();
  return { feature, calls, human, ctx, state: () => state };
}

test('composed feature registers its Human surface before starting, and default-off construction never samples', async t => {
  const h = await fixture(t);
  assert.equal(h.calls.definition, ActivityLedgerDomain); assert.equal(h.calls.contributions.length, 1);
  assert.deepEqual(h.feature.getSettings(), { enabled: false, applications: [], contextApplications: [], retentionDays: 7 });
  assert.equal(h.calls.spawns.length, 0); assert.equal(h.calls.native.length, 0);
  await h.human.action({ action: 'configure', applications: [APPLICATIONS[0].id] });
  await flush(); assert.equal(h.feature.getSettings().enabled, false); assert.equal(h.calls.spawns.length, 0);
  const listed = await h.human.action({ action: 'list', limit: 20 }); assert.deepEqual(listed.data.entries, []);
  await h.feature.dispose(); await h.feature.dispose(); assert.equal(h.calls.closes, 1);
});

test('a readonly composed status invokes only native status, not foreground sample or a model task', async t => {
  const h = await fixture(t), response = await h.human.action({ action: 'status' });
  assert.equal(response.data.ledger.state, 'paused'); assert.equal(response.data.ledger.capabilities.accessibilityTrusted, false);
  assert.equal(response.data.voice, null); assert.deepEqual(response.data.documents.roots, ['/approved']);
  assert.equal(h.calls.spawns.length, 1);
  assert.deepEqual(JSON.parse(h.calls.spawns[0].argv.at(-1)), { v: 1, action: 'status' });
});

test('failed storage still exposes an honest Human unavailable surface and preserves the independent folder/voice controls', async t => {
  const h = await fixture(t, { failStorage: true });
  assert.equal(h.feature.getController(), null); assert.equal(h.calls.spawns.length, 0);
  const result = await h.human.action({ action: 'status' });
  assert.equal(result.data.ledger.state, 'unavailable'); assert.equal(result.data.ledger.settings.enabled, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|profile\/secret/);
  assert.deepEqual((await h.human.action({ action: 'folders' })).data.roots, ['/approved']);
  await assert.rejects(h.human.action({ action: 'configure', enabled: true }), /暂不可用/);
  assert.equal(await h.feature.captureCurrent(), null);
});

test('Human accessibility control only requests system settings; folder pause is not recording consent', async t => {
  const h = await fixture(t);
  const result = await h.human.action({ action: 'open_accessibility' });
  assert.equal(result.data.status, 'open_requested'); assert.match(result.data.message, /手动授权/);
  assert.deepEqual(h.calls.native, [['/usr/bin/open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']]);
  await h.human.action({ action: 'set_search_enabled', enabled: false });
  assert.deepEqual(h.calls.folders, [{ action: 'set_enabled', enabled: false }]); assert.equal(h.feature.getSettings().enabled, false);
  const nonOwner = h.ctx.extend({ invocation: { peer: { principal: { kind: 'agent' }, interactions: 'answer' } } }).get('workfilesActivity');
  await assert.rejects(nonOwner.action({ action: 'open_accessibility' }), /本机用户/); assert.equal(h.calls.native.length, 1);
});

test('running-app discovery is an explicit Owner operation, never implicit in status or app selection', async t => {
  const h = await fixture(t);
  await h.human.action({ action: 'status' });
  assert.deepEqual(h.calls.spawns.map(spec => JSON.parse(spec.argv[4]).action), ['status']);
  const found = await h.human.action({ action: 'discover_applications' });
  assert.equal(found.data.applications[0].id, 'com.electron.lark'); assert.equal(found.data.truncated, false);
  assert.deepEqual(h.feature.getSettings().applications, []); assert.equal(h.feature.getSettings().enabled, false);
  await h.human.action({ action: 'set_application', id: 'com.electron.lark', selected: true });
  await h.human.action({ action: 'status' });
  assert.deepEqual(h.calls.spawns.map(spec => JSON.parse(spec.argv[4]).action), ['status', 'applications']);
  assert.equal(h.feature.getSettings().enabled, false); assert.deepEqual(h.feature.getSettings().contextApplications, []);
});

test('Owner delta revocations use serialized current policy, never restore another revoked checkbox', async t => {
  const h = await fixture(t), A = APPLICATIONS[0].id, B = APPLICATIONS[1].id;
  await h.human.action({ action: 'configure', applications: [A, B], contextApplications: [A, B] });
  await Promise.all([h.human.action({ action: 'set_context', id: A, allowed: false }), h.human.action({ action: 'set_context', id: B, allowed: false })]);
  assert.deepEqual(h.feature.getSettings().contextApplications, []);
  await Promise.all([h.human.action({ action: 'set_application', id: A, selected: false }), h.human.action({ action: 'set_application', id: B, selected: false })]);
  assert.deepEqual(h.feature.getSettings().applications, []); assert.equal(h.feature.getSettings().enabled, false);
  await assert.rejects(h.human.action({ action: 'set_context', id: A, allowed: true }), { code: 'SCOPE_REVOKED' });
  assert.deepEqual(h.feature.getSettings().applications, []); assert.deepEqual(h.feature.getSettings().contextApplications, []);
  assert.equal(h.calls.spawns.length, 0); assert.equal(h.calls.native.length, 0);
});

test('one-click select-all selects the running apps atomically and never grants metadata', async t => {
  const h = await fixture(t), A = APPLICATIONS[0].id;
  await h.human.action({ action: 'configure', applications: [A], contextApplications: [A] });
  const result = (await h.human.action({ action: 'select_running_applications' })).data;
  assert.deepEqual(result.settings.applications, [A, 'com.electron.lark']);
  assert.deepEqual(result.settings.contextApplications, [A], 'window metadata consent is untouched');
  assert.equal(result.settings.enabled, false, 'select-all never starts recording');
  assert.deepEqual(result.discovered, { applications: 1, truncated: false });
  // A second click is idempotent rather than duplicating or reordering identities.
  assert.deepEqual((await h.human.action({ action: 'select_running_applications' })).data.settings.applications, [A, 'com.electron.lark']);
  assert.equal(h.calls.spawns.filter(spec => JSON.parse(spec.argv[4]).action === 'applications').length, 2);
  assert.equal(h.calls.spawns.some(spec => JSON.parse(spec.argv[4]).action === 'sample'), false);
});

test('optional voice service uses fixed explicit operations without creating an Agent/Session for settings', async t => {
  const actions = [], voice = { status: () => ({ running: true, registered: true }), open: async opts => { actions.push(opts); return { shown: true }; }, cancel() { actions.push('cancel'); }, async configureShortcut(shortcut, opts) { assert.ok(opts.signal); actions.push(shortcut); return { shortcut, persisted: true }; } };
  const h = await fixture(t, { voice }), caller = new AbortController();
  assert.equal((await h.human.action({ action: 'voice_status' })).data.registered, true);
  await h.human.action({ action: 'voice_show' }); await h.human.action({ action: 'voice_record' }); await h.human.action({ action: 'voice_cancel' });
  assert.equal((await h.human.action({ action: 'voice_shortcut', shortcut: 'CommandOrControl+Shift+K' }, caller.signal)).data.persisted, true);
  assert.deepEqual(actions, [{ capture: false }, { capture: true }, 'cancel', 'CommandOrControl+Shift+K']);
  assert.equal(h.calls.spawns.length, 0);
});
