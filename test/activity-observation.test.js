import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createDocumentEngine } from '../lib/documents.js';
import { LocalTestFilesystem, temporary, textFile } from './helpers.js';

// Only synthetic files in this test's verified owned directory. No application
// is opened, no AX call is made, and document bodies must never be read.
function fixture(root, options = {}) {
  const provider = new LocalTestFilesystem(), opens = [];
  const engine = createDocumentEngine({ fs: provider, roots: () => [root], enabled: () => true, platform: 'darwin', runNative: async argv => { opens.push(argv); return {}; }, ...options });
  return { provider, engine, opens };
}

test('observation seam derives only name/path/kind/mtime from canonical ordinary files, without byte reads', async t => {
  const root = await temporary(t), file = await textFile(root, 'synthetic-report.txt', 'DO NOT READ BODY', '2026-11-02T03:00:00Z');
  const h = fixture(root), value = await h.engine.describeObservedDocument(file);
  assert.deepEqual(value, { name: 'synthetic-report.txt', path: file, kind: 'text', modifiedAt: '2026-11-02T03:00:00.000Z' });
  assert.deepEqual(h.provider.reads, []); assert.deepEqual(h.opens, []);
});

test('a validated observation becomes a fresh same-engine candidate but never opens itself', async t => {
  const root = await temporary(t), file = await textFile(root, 'synthetic.txt'); const h = fixture(root);
  const one = await h.engine.observedCandidate(file), two = await h.engine.observedCandidate(file);
  assert.notEqual(one.id, two.id); assert.equal(one._identity.key, two._identity.key);
  assert.equal(one.contentStatus, 'not_read'); assert.deepEqual(h.provider.reads, []); assert.deepEqual(h.opens, []);
});

test('file search pause and separately consented metadata recording are independent, without granting an open capability', async t => {
  const root = await temporary(t), file = await textFile(root, 'synthetic.txt'); let enabled = true;
  const h = fixture(root, { enabled: () => enabled }); const candidate = await h.engine.observedCandidate(file); enabled = false;
  assert.equal((await h.engine.describeObservedDocument(file)).name, 'synthetic.txt');
  await assert.rejects(h.engine.observedCandidate(file), { code: 'PAUSED' });
  await assert.rejects(h.engine.open(candidate), { code: 'PAUSED' });
  assert.deepEqual(h.provider.reads, []); assert.deepEqual(h.opens, []);
});

test('revoked/outside canonical observation is rejected before resolving that external target', async t => {
  const root = await temporary(t), h = fixture(root), resolutions = [], original = h.provider.resolve.bind(h.provider);
  h.provider.resolve = async (...args) => { resolutions.push(args[0]); return original(...args); };
  await assert.rejects(h.engine.describeObservedDocument('/unapproved/private-title.txt'), { code: 'OUTSIDE_SCOPE' });
  assert.equal(resolutions.includes('/unapproved/private-title.txt'), false); assert.deepEqual(h.provider.reads, []);
});

test('in-root symlink to an unapproved target cannot create either metadata or a candidate', async t => {
  const base = await temporary(t), allowed = path.join(base, 'allowed'), outside = path.join(base, 'outside');
  await fs.mkdir(allowed); await fs.mkdir(outside); const privateFile = await textFile(outside, 'secret.txt');
  const link = path.join(allowed, 'alias.txt'); await fs.symlink(privateFile, link); const h = fixture(allowed);
  await assert.rejects(h.engine.describeObservedDocument(link), { code: 'OUTSIDE_SCOPE' });
  await assert.rejects(h.engine.observedCandidate(link), { code: 'OUTSIDE_SCOPE' }); assert.deepEqual(h.provider.reads, []);
});

test('missing, unsupported or non-regular observations cannot become metadata capabilities', async t => {
  const root = await temporary(t), h = fixture(root); await fs.mkdir(path.join(root, 'directory.txt')); await textFile(root, 'script.command');
  for (const name of ['missing.txt', 'directory.txt', 'script.command']) await assert.rejects(h.engine.describeObservedDocument(path.join(root, name)));
  assert.deepEqual(h.provider.reads, []); assert.deepEqual(h.opens, []);
});

test('scope removal is checked on every observation, not trusted from a persisted path', async t => {
  const root = await temporary(t), file = await textFile(root, 'synthetic.txt'); let roots = [root];
  const h = fixture(root, { roots: () => roots }); await h.engine.describeObservedDocument(file); roots = [];
  await assert.rejects(h.engine.describeObservedDocument(file), { code: 'OUTSIDE_SCOPE' });
});

test('the final enabled/scope getter may invalidate a signal and cannot still return metadata', async t => {
  const root = await temporary(t), file = await textFile(root, 'synthetic.txt'), caller = new AbortController(); let invalidating = false;
  const h = fixture(root, { enabled: () => { if (invalidating) caller.abort(new Error('scope changed during validation')); return true; } });
  const stat = h.provider.stat.bind(h.provider);
  h.provider.stat = async target => { const value = await stat(target); if (target.targetKey === file) invalidating = true; return value; };
  await assert.rejects(h.engine.describeObservedDocument(file, caller.signal), /scope changed during validation/);
  assert.deepEqual(h.provider.reads, []);
});
