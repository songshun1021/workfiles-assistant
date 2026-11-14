import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDocumentEngine, isInside, termsFor } from '../lib/documents.js';
import { createNativeRunner, spotlightCandidates, spotlightQuery } from '../lib/native.js';
import { LocalTestFilesystem, temporary, textFile } from './helpers.js';
const exec = promisify(execFile);
function engineFor(root, extra = {}) {
  const provider = new LocalTestFilesystem(); const calls = [];
  const native = async argv => { calls.push(argv); return { stdout: '', truncated: false }; };
  return { engine: createDocumentEngine({ fs: provider, roots: () => [root], runNative: native, platform: 'darwin', ...extra }), provider, calls };
}

test('segment-aware scope rejects prefix siblings', () => {
  assert.equal(isInside('/a/allowed', '/a/allowed/file.pptx'), true);
  assert.equal(isInside('/a/allowed', '/a/allowed-secret/file.pptx'), false);
  assert.equal(isInside('/a/allowed', '/a/allowed/../outside/file.pptx'), false);
});
test('newest means newest relevant presentation, not newest unrelated file', async t => {
  const root = await temporary(t);
  await textFile(root, '课题_报告_旧版.pptx', 'old', '2026-11-01T10:00:00Z');
  await textFile(root, '课题_报告_新版.pptx', 'new', '2026-11-10T10:00:00Z');
  await textFile(root, '无关预算.pptx', 'other', '2026-11-11T10:00:00Z');
  await textFile(root, '课题_报告.docx', 'wrong type', '2026-11-12T10:00:00Z');
  const { engine, provider } = engineFor(root);
  const result = await engine.search({ query: '课题 报告', sort: 'modified' });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].name, '课题_报告_新版.pptx');
  assert.equal(result.candidates[0].modifiedAt, '2026-11-10T10:00:00.000Z');
  assert.equal(provider.reads.length, 0, 'metadata search must not read document bytes');
  assert.equal(result.coverage.scanComplete, true);
});
test('full-term match wins over a newer partial hit when sorted by modification', async t => {
  const root = await temporary(t);
  await textFile(root, '课题_报告.pptx', '', '2026-11-01T10:00:00Z');
  await textFile(root, '无关课题.pptx', '', '2026-11-12T10:00:00Z');
  const result = await engineFor(root).engine.search({ query: '课题 报告', sort: 'modified' });
  assert.equal(result.candidates.length, 1); assert.equal(result.partialMatchesOnly, false);
});
test('folder and timezone-aware modification bounds are enforced', async t => {
  const root = await temporary(t);
  await textFile(root, 'A/报告.pptx', '', '2026-11-10T10:00:00Z');
  await textFile(root, 'B/报告.pptx', '', '2026-11-11T10:00:00Z');
  const { engine } = engineFor(root);
  const result = await engine.search({ query: '报告', folder: path.join(root, 'B'), modifiedAfter: '2026-11-11T00:00:00+08:00', modifiedBefore: '2026-11-12T00:00:00+08:00' });
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].folder, path.join(root, 'B'));
  await assert.rejects(engine.search({ modifiedAfter: '2026-11-11' }), { code: 'INVALID_DATE' });
  await assert.rejects(engine.search({ folder: path.dirname(root) }), { code: 'OUTSIDE_SCOPE' });
});
test('symlinks and unsupported executables cannot escape document scope', async t => {
  const base = await temporary(t); const allowed = path.join(base, 'allowed'); const outside = path.join(base, 'outside');
  await fs.mkdir(allowed); await fs.mkdir(outside);
  const secret = await textFile(outside, '报告_秘密.pptx');
  await fs.symlink(secret, path.join(allowed, '报告_链接.pptx'));
  await fs.symlink(outside, path.join(allowed, 'linked-directory'));
  await textFile(allowed, '报告.command'); await textFile(allowed, '报告.pptm');
  await textFile(allowed, 'node_modules/报告.pptx'); await textFile(allowed, '.hidden/报告.pptx');
  await textFile(allowed, '~$报告.pptx'); await textFile(allowed, '报告_可见.pptx');
  const { engine, provider } = engineFor(allowed);
  const result = await engine.search({ query: '报告' });
  assert.deepEqual(result.candidates.map(item => item.name), ['报告_可见.pptx']);
  assert.ok(provider.listings.every(item => isInside(allowed, item)));
  assert.equal(provider.reads.length, 0);
});
test('canonical root aliases to the home directory or filesystem root are rejected', async t => {
  const base = await temporary(t);
  const { engine } = engineFor(base);
  await fs.symlink(os.homedir(), path.join(base, 'home-alias'));
  await fs.symlink('/', path.join(base, 'root-alias'));
  await assert.rejects(engine.validateDirectory(path.join(base, 'home-alias')), { code: 'SCOPE_TOO_BROAD' });
  await assert.rejects(engine.validateDirectory(path.join(base, 'root-alias')), { code: 'SCOPE_TOO_BROAD' });
  const noScope = engineFor(path.join(base, 'home-alias')).engine;
  assert.equal((await noScope.status()).roots.length, 0);
});
test('bounded fallback explicitly reports incomplete coverage', async t => {
  const root = await temporary(t);
  for (let index = 0; index < 5; index++) await textFile(root, `报告_${index}.pptx`);
  const { engine } = engineFor(root, { limits: { maxEntries: 1 } });
  const result = await engine.search({ query: '报告' });
  assert.equal(result.coverage.scanComplete, false);
  assert.ok(result.warnings.some(item => item.includes('上限')));
});
test('Spotlight errors fall back, without claiming no files exist', async t => {
  const root = await temporary(t); await textFile(root, '报告.pptx');
  const { engine } = engineFor(root, { runNative: async () => { throw new Error('index unavailable'); } });
  const result = await engine.search({ query: '报告' });
  assert.equal(result.candidates.length, 1); assert.ok(result.warnings.some(item => item.includes('系统索引')));
});
test('opening uses only the validated absolute path, never a shell', async t => {
  const root = await temporary(t); const name = '课题;$(touch nope)\n报告.pptx';
  await textFile(root, name);
  const { engine, calls } = engineFor(root);
  const candidate = (await engine.search({ query: '报告' })).candidates[0];
  const opened = await engine.open(candidate);
  assert.equal(opened.status, 'open_requested'); assert.equal(opened.documentVisibleConfirmed, false);
  assert.deepEqual(calls.at(-1), ['/usr/bin/open', path.join(root, name)]);
});
test('changed, deleted, replaced, or revoked candidates cannot be opened', async t => {
  const root = await temporary(t); const file = await textFile(root, '课题报告.pptx');
  let roots = [root];
  const { engine, calls } = engineFor(root, { roots: () => roots });
  const first = (await engine.search({ query: '报告' })).candidates[0];
  await fs.writeFile(file, 'changed content');
  await assert.rejects(engine.open(first), { code: 'STALE_CANDIDATE' });
  const second = (await engine.search({ query: '报告' })).candidates[0];
  roots = [];
  await assert.rejects(engine.open(second), { code: 'OUTSIDE_SCOPE' });
  roots = [root];
  const displaced = `${file}.old`;
  assert.equal(path.dirname(path.resolve(file)), path.resolve(root)); assert.equal(path.dirname(path.resolve(displaced)), path.resolve(root));
  await fs.rename(file, displaced); await textFile(root, '课题报告.pptx');
  await assert.rejects(engine.open(second), { code: 'STALE_CANDIDATE' });
  // Deletion is limited to the exact test-owned fixture whose resolved parent was checked.
  assert.equal(path.dirname(path.resolve(file)), path.resolve(root)); await fs.unlink(file);
  await assert.rejects(engine.open(second), { code: 'FILE_NOT_FOUND' });
  assert.equal(calls.filter(argv => argv[0] === '/usr/bin/open').length, 0);
});
test('paused search blocks content/open but status is still available for recovery', async t => {
  const root = await temporary(t); await textFile(root, '报告.pptx');
  const { engine } = engineFor(root, { enabled: () => false });
  assert.equal((await engine.status()).roots.length, 1);
  await assert.rejects(engine.search(), { code: 'PAUSED' });
});
test('malformed Office content is reported as unreadable, not no match', async t => {
  const root = await temporary(t); await textFile(root, '报告.pptx', 'not a ZIP');
  const result = await engineFor(root).engine.search({ query: '报告', content: true });
  assert.equal(result.candidates[0].contentStatus, 'unreadable');
  assert.equal(result.coverage.contentFailures, 1);
  assert.ok(result.warnings.some(item => item.includes('正文无法读取')));
});
test('content budget is visible and no document bytes are read by default', async t => {
  const root = await temporary(t); await textFile(root, '线索.txt', '正文独特短语'); await textFile(root, '第二份.txt', '正文独特短语');
  const { engine, provider } = engineFor(root, { limits: { maxContentFiles: 1 } });
  const first = await engine.search({ query: '独特短语', kind: 'text' });
  assert.equal(first.candidates.length, 0); assert.equal(provider.reads.length, 0);
  const second = await engine.search({ query: '独特短语', kind: 'text', content: true });
  assert.equal(second.candidates.length, 1); assert.equal(second.coverage.contentFilesRead, 1);
  assert.ok(second.warnings.some(item => item.includes('正文仅检查')));
});
test('cancellation stops before scanning', async t => {
  const root = await temporary(t); const { engine, provider } = engineFor(root);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.search({}, controller.signal), { name: 'AbortError' }); assert.equal(provider.listings.length, 0);
});
test('Spotlight uses NUL-separated paths, safely escapes query literals, and rejects truncated fragments', async () => {
  const calls = []; const raw = '/a/报告\n含换行.pptx';
  const result = await spotlightCandidates(async argv => { calls.push(argv); return { stdout: `${raw}\0`, truncated: false }; }, '/a', ['课题" || evil'], ['pptx']);
  assert.deepEqual(result.paths, [raw]); assert.deepEqual(calls[0].slice(0, 4), ['/usr/bin/mdfind', '-0', '-onlyin', '/a']);
  assert.ok(spotlightQuery(['a"*?\\'], ['pptx']).includes('a\\"\\*\\?\\\\'));
  const partial = await spotlightCandidates(async () => ({ stdout: 'partial-tail\0/a/real.pptx\0incomplete', truncated: true }), '/a', [], ['pptx']);
  assert.deepEqual(partial.paths, ['/a/real.pptx']); assert.equal(partial.truncated, true);
});
test('native adapter bounds output, excludes inherited secrets and propagates failures', async () => {
  const specifications = [];
  const subprocess = { spawn(spec) { specifications.push(spec); return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text: 'ok', lossy: false }) } }, terminate() {}, waitForExit: async () => true }; } };
  const result = await createNativeRunner(subprocess)(['/usr/bin/open', '/a/报告.pptx']);
  assert.equal(result.stdout, 'ok'); assert.equal(specifications[0].stdio.stdout.maxBytes, 512 * 1024);
  assert.equal(specifications[0].env.OPENAI_API_KEY, undefined); assert.ok(!Object.hasOwn(specifications[0], 'shell'));
  const bad = createNativeRunner({ spawn() { return { done: Promise.resolve({ exitCode: 1, signal: null }), collected: {}, terminate() {}, waitForExit: async () => true }; } });
  await assert.rejects(bad(['/usr/bin/open', '/a']), { code: 'NATIVE_COMMAND_FAILED' });
});
test('real python-pptx files: latest relevant selection, semantic body fallback and page inspection', async t => {
  const root = await temporary(t);
  const script = fileURLToPath(new URL('./create_test_presentations.py', import.meta.url));
  await exec('/Users/sean/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3', [script, root], { timeout: 15000, maxBuffer: 16384 });
  const { engine } = engineFor(root);
  const named = await engine.search({ query: '光学课题 报告', sort: 'modified' });
  assert.equal(named.candidates[0].name, '光学课题_报告_新版.pptx');
  const content = await engine.search({ query: '偏振光谱仪', content: true });
  assert.equal(content.candidates[0].name, '组会资料_验收样例.pptx');
  assert.ok(content.candidates[0].snippet.includes('偏振光谱仪'));
  const detail = await engine.inspect(content.candidates[0]);
  assert.equal(detail.slides[0].number, 1); assert.ok(detail.text.includes('偏振光谱仪')); assert.ok(detail.text.includes('自动生成的测试资料'));
  assert.equal(detail.contentIsUntrustedData, true);
});
test('query length and result bounds are enforced', async t => {
  const root = await temporary(t); const { engine } = engineFor(root);
  assert.throws(() => termsFor('a'.repeat(513)), { code: 'INVALID_QUERY' });
  await assert.rejects(engine.search({ limit: 21 }), { code: 'INVALID_SEARCH' });
  await assert.rejects(engine.search({ kind: 'executable' }), { code: 'INVALID_KIND' });
});
