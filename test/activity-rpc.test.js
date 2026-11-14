import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { ActivityActionSchema, ActivityResultSchema, ActivityHostContribution, ActivityInvocation, registerActivityRemote } from '../lib/activity-rpc.js';

// Actual public Cordis Context/Service, not a fake scoped binding. Only the
// contribution sink and business operation are doubles; no Host/profile/OS IO.
function fixture(perform = async input => input) {
  const ctx = new Context(), contributions = [];
  ctx.provide('typert', { register(contribution) { contributions.push(contribution); return () => {}; } });
  const service = registerActivityRemote(ctx, perform, Service);
  const scoped = (kind = 'owner', interactions = 'answer') => ctx.extend({ invocation: { peer: { principal: { kind }, interactions } } }).get('workfilesActivity');
  return { ctx, service, scoped, contributions };
}

test('public Service rebinds actual invocation scope without needing a Session/Agent', async () => {
  const f = fixture(async input => ({ action: input.action, value: 7, absent: undefined }));
  assert.deepEqual(await f.scoped().action({ action: 'status' }), { ok: true, data: { action: 'status', value: 7 } });
  assert.equal(f.contributions[0], ActivityHostContribution);
  assert.equal(f.service.typertRemote.service, f.service);
  assert.equal(f.service.typertRemote.serviceKey, ActivityInvocation.service);
  assert.equal(f.service.typertRemote.namespace, ActivityInvocation.namespace);
});

for (const [kind, interactions] of [['agent', 'answer'], ['owner', 'none'], ['viewer', 'answer'], ['owner', undefined]]) {
  test(`privilege gate rejects ${kind}/${interactions} before executing a business operation`, async () => {
    let calls = 0; const f = fixture(async () => { calls++; return true; });
    const receiver = f.ctx.extend({ invocation: { peer: { principal: { kind }, interactions } } }).get('workfilesActivity');
    await assert.rejects(receiver.action({ action: 'configure', enabled: true }), /本机用户/); assert.equal(calls, 0);
  });
}

test('a provided but unscoped service cannot acquire Human authority from input JSON', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  await assert.rejects(f.service.action({ action: 'configure', enabled: true, peer: { principal: { kind: 'owner' } } }), /本机用户/);
  assert.equal(calls, 0);
});

test('actual scoped owner is still subject to strict input and abort validation', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return {}; });
  await assert.rejects(f.scoped().action({ action: 'configure', retentionDays: 30 }));
  const owner = new AbortController(); owner.abort(new Error('cancel settings'));
  await assert.rejects(f.scoped().action({ action: 'status' }, owner.signal), /cancel settings/);
  assert.equal(calls, 0);
});

test('cancellation after business completion does not emit a false success envelope', async () => {
  const owner = new AbortController(), f = fixture(async () => { owner.abort(new Error('late caller cancel')); return { saved: true }; });
  await assert.rejects(f.scoped().action({ action: 'status' }, owner.signal), /late caller cancel/);
});

test('Host codec strictly rejects permission fields, unknown apps/actions, invalid date bounds and payload budgets', () => {
  for (const input of [
    { action: 'configure', applications: ['com.microsoft.edgemac\n'] }, { action: 'configure', accessibilityTrusted: true },
    { action: 'enable_permissions' }, { action: 'clear', path: '/outside' }, { action: 'status', sessionId: 'invented' },
    { action: 'list', limit: 21 }, { action: 'list', after: '2026-11-13T00:00:00' }, { action: 'voice_shortcut', shortcut: 'Cmd+\nX' },
  ]) assert.equal(ActivityActionSchema.safeParse(input).success, false);
  assert.equal(ActivityResultSchema.safeParse({ ok: true, data: 'x'.repeat(262145) }).success, false);
  assert.equal(ActivityResultSchema.safeParse({ ok: true, data: { time: new Date() } }).success, false);
  assert.equal(ActivityResultSchema.safeParse({ ok: true, data: null, private: true }).success, false);
});

test('dynamic-app/delta/discovery/open codecs are strict data, not permission or arbitrary URL endpoints', async () => {
  const id = 'wa-00000000-0000-4000-8000-000000000000';
  for (const input of [
    { action: 'configure', applications: ['com.microsoft.edgemac'], contextApplications: [] },
    { action: 'configure', contextApplications: ['com.electron.lark'] },
    { action: 'set_application', id: 'com.electron.lark', selected: true },
    { action: 'set_context', id: 'com.electron.lark', allowed: false },
    { action: 'discover_applications' }, { action: 'select_running_applications' }, { action: 'open_observed', id },
  ]) assert.deepEqual(ActivityActionSchema.parse(input), input);
  for (const input of [
    { action: 'set_application', id: 'com.electron.lark', selected: true, enabled: true },
    { action: 'set_context', id: 'com.electron.lark', allowed: true, accessibilityTrusted: true },
    { action: 'configure', applications: [], contextApplications: ['com.electron.lark'] },
    { action: 'configure', applications: ['com.electron.lark', 'com.electron.lark'] },
    { action: 'configure', applications: Array.from({ length: 129 }, (_, n) => `com.example.App${n}`) },
    { action: 'discover_applications', applications: ['com.electron.lark'] },
    { action: 'open_observed', id: id + '\n' }, { action: 'open_observed', id, url: 'https://example.com/doc' },
  ]) assert.equal(ActivityActionSchema.safeParse(input).success, false);
  let calls = 0; const f = fixture(async () => { calls++; return {}; });
  for (const input of [{ action: 'discover_applications' }, { action: 'open_observed', id }, { action: 'set_context', id: 'com.electron.lark', allowed: true }]) await assert.rejects(f.scoped('agent').action(input), /本机用户/);
  assert.equal(calls, 0);
});

test('strict codecs materialize working schemas and only the explicit endpoint is exposed', () => {
  assert.equal(ActivityInvocation.invocation.kind, 'direct');
  assert.equal(ActivityInvocation.parameters.length, 1); assert.equal(ActivityInvocation.parameters[0].source, 'json');
  assert.equal(ActivityInvocation.parameters[0].wire, 'input'); assert.equal(ActivityInvocation.cancellation.parameter, 'signal');
  assert.deepEqual(ActivityInvocation.parameters[0].codec.create().parse({ action: 'status' }), { action: 'status' });
  assert.deepEqual(ActivityInvocation.result.create().parse({ ok: true, data: null }), { ok: true, data: null });
  assert.equal(ActivityHostContribution.invocations.length, 1);
});
