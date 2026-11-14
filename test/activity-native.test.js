import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { createMacActivitySource, MAC_ACTIVITY_APPLICATIONS } from '../lib/activity-native.js';

// Only in-memory subprocess and filesystem doubles. Never spawns osascript or reads an app/window.
const TIME = '2026-11-13T16:00:00.000Z';
const WORD = MAC_ACTIVITY_APPLICATIONS[0];
const EDGE = { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' };
const FEISHU = { id: 'com.electron.lark', name: '飞书 🐦' };
const PARENT = '/owned/bundle', ROOT = '/allowed/work', DOC = `${ROOT}/report.docx`;
const PROGRAM = `${PARENT}/native/context-reader.js`;
const request = () => ({ applications: [WORD.id], roots: [ROOT] });
const sample = (extra = {}) => ({ v: 1, observedAt: TIME, app: { ...WORD, pid: 42 }, document: { path: DOC, title: '报告' }, ...extra });
const status = (extra = {}) => ({ v: 1, platform: 'darwin', source: 'jxa-applicationservices', available: true,
  accessibilityTrusted: false, applications: MAC_ACTIVITY_APPLICATIONS.map(app => ({ ...app, installed: true })), reason: 'accessibility_required_for_documents', ...extra });
const discovery = (applications = [], extra = {}) => ({ v: 1, platform: 'darwin', source: 'jxa-applicationservices',
  applications: applications.map(app => ({ ...app, installed: true, running: true, foreground: app.foreground !== false })), truncated: false, ...extra });
const contextRequest = (app = EDGE, extra = {}) => ({ applications: [app.id], contextApplications: [app.id], roots: [], ...extra });
const appSnapshot = (app = EDGE, extra = {}) => ({ v: 1, observedAt: TIME, app: { ...app, pid: 42 }, ...extra });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixtureFS(options = {}) {
  const calls = [];
  const result = {
    calls,
    async realpath(value) { calls.push(['realpath', value]); return options.realpath ? options.realpath(value) : value; },
    async stat(value) { calls.push(['stat', value]); return { isDirectory: () => value === ROOT || value === '/other/work' }; },
    async lstat(value) {
      calls.push(['lstat', value]);
      return { isFile: () => value === PROGRAM || options.regular !== false, isDirectory: () => false,
        isSymbolicLink: () => value === PROGRAM && options.scriptSymlink === true, size: value === PROGRAM ? options.scriptSize ?? 9000 : 8 };
    },
  };
  return result;
}
function managedChild(options = {}) {
  const outcome = deferred(), range = deferred();
  const child = {
    stdout: new PassThrough(), stderr: new PassThrough(), done: outcome.promise, terminations: 0, waits: 0, finished: false,
    terminate() { this.terminations++; if (options.ignoreTerminate !== true) this.exit(null, 'SIGTERM'); },
    waitForExit() { this.waits++; return options.ignoreWait ? new Promise(() => {}) : range.promise; },
    raw(value) { if (!this.stdout.writableEnded) this.stdout.write(value); },
    reply(value) { this.raw(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); this.exit(0); },
    exit(exitCode = 0, signal = null) {
      if (this.finished) return;
      this.finished = true; this.stdout.end(); this.stderr.end(); outcome.resolve({ exitCode, signal }); range.resolve(true);
    },
    fail(error) { this.stdout.end(); this.stderr.end(); outcome.reject(error); range.resolve(true); this.finished = true; },
  };
  if (options.noStdout) child.stdout = undefined;
  return child;
}
function harness(t, options = {}) {
  const spawns = [], children = [], fileSystem = options.fileSystem || fixtureFS(options.fs);
  const subprocess = { spawn(spec) {
    spawns.push(spec);
    if (options.spawnError) throw options.spawnError;
    const child = managedChild(options.child); children.push(child);
    if (options.auto !== false) queueMicrotask(() => {
      if (options.raw !== undefined) child.reply(options.raw);
      else {
        const action = JSON.parse(spec.argv.at(-1)).action;
        child.reply(options.value ?? (action === 'status' ? status() : action === 'applications' ? discovery([FEISHU, EDGE]) : sample()));
      }
    });
    return child;
  } };
  const source = createMacActivitySource({ subprocess, bundleRoot: PARENT, platform: options.platform ?? 'darwin', fileSystem,
    now: () => TIME, timeoutMs: options.timeoutMs ?? 500, cleanupMs: options.cleanupMs ?? 20, signal: options.signal,
    env: { HOME: '/home/fixture', TMPDIR: '/tmp/fixture', LANG: 'zh_CN.UTF-8', TOKEN: 'private', DSH_SECRET: 'private', NODE_OPTIONS: '--require evil', DYLD_INSERT_LIBRARIES: '/evil', OSA_COMPONENT_PATH: '/evil' } });
  t.after(() => source.dispose().catch(() => {}));
  return { source, spawns, children, fileSystem };
}

test('constructing reader is passive; status only invokes fixed static program with bounded managed pipes', async t => {
  const h = harness(t);
  assert.equal(h.spawns.length, 0);
  const value = await h.source.status();
  assert.equal(value.available, true);
  assert.equal(value.accessibilityTrusted, false);
  assert.equal(value.reason, 'accessibility_required_for_documents');
  assert.deepEqual(value.applications, status().applications);
  const spec = h.spawns[0];
  assert.deepEqual(spec.argv.slice(0, 4), ['/usr/bin/osascript', '-l', 'JavaScript', PROGRAM]);
  assert.deepEqual(JSON.parse(spec.argv[4]), { v: 1, action: 'status' });
  assert.equal(spec.cwd, PARENT);
  assert.deepEqual(spec.stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  assert.equal(spec.graceMs, 250);
  assert.ok(spec.signal instanceof AbortSignal);
  assert.equal(spec.env.HOME, '/home/fixture');
  assert.equal(spec.env.TOKEN, undefined);
  assert.equal(spec.env.DSH_SECRET, undefined);
  assert.equal(spec.env.NODE_OPTIONS, undefined);
  assert.equal(spec.env.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(spec.env.OSA_COMPONENT_PATH, undefined);
  assert.equal(spec.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.ok(h.children[0].waits > 0);
});

test('canonical selected-app document passes, host timestamp is authoritative, caller cannot supply code', async t => {
  const h = harness(t, { value: sample({ observedAt: '2001-01-01T00:00:00.000Z' }) });
  assert.deepEqual(await h.source.sample(request()), sample());
  const argument = JSON.parse(h.spawns[0].argv.at(-1));
  assert.deepEqual(argument, { v: 1, action: 'sample', applications: [WORD.id], contextApplications: [], roots: [ROOT] });
});

test('app metadata remains usable without document permission', async t => {
  const h = harness(t, { value: { v: 1, observedAt: TIME, app: { ...WORD, pid: 42 }, reason: 'accessibility_required_for_documents' } });
  const result = await h.source.sample(request());
  assert.deepEqual(result.app, { ...WORD, pid: 42 });
  assert.equal(result.document, undefined);
  assert.equal(result.reason, 'accessibility_required_for_documents');
});

test('non-selected current app is null, never exposes another name/title', async t => {
  const h = harness(t, { value: { v: 1, observedAt: TIME, app: null, reason: 'APP_NOT_ALLOWED' } });
  assert.equal((await h.source.sample(request())).app, null);
});

test('malformed or duplicate application selections and invalid roots are rejected before any spawn', async t => {
  const h = harness(t);
  for (const applications of [[WORD.id, WORD.id], ['com.microsoft.Word;evil'], ['plain'], ['com..app'], ['.com.app'],
    ['com.app.'], [`com.${'x'.repeat(252)}`], ['com.🙂'], ['com.app\n'], ['com.app\u2028'], ['com.app\u2029'], Array(1),
    Array.from({ length: 129 }, (_, i) => `org.example.app${i}`), 'com.example.app']) {
    await assert.rejects(h.source.sample({ applications, roots: [ROOT] }), { code: 'INVALID_APPLICATIONS' });
  }
  for (const roots of [['/'], ['relative'], [`${ROOT}/../other`], [`${ROOT}\u0000secret`], [ROOT, ROOT], Array(1)]) {
    await assert.rejects(h.source.sample({ applications: [WORD.id], roots }), { code: 'INVALID_SCOPE' });
  }
  assert.equal(h.spawns.length, 0);
});

test('empty selection and unsupported platform do not invoke native program', async t => {
  const h = harness(t);
  assert.equal((await h.source.sample({ applications: [], roots: [ROOT] })).reason, 'NO_SELECTED_APPLICATIONS');
  assert.equal(h.spawns.length, 0);
  const linux = harness(t, { platform: 'linux' });
  assert.equal((await linux.source.status()).reason, 'UNSUPPORTED_PLATFORM');
  assert.equal((await linux.source.sample(request())).app, null);
  assert.equal(linux.spawns.length, 0);
});

test('roots must be existing canonical directories; symlink scope is never silently expanded', async t => {
  const h = harness(t, { fs: { realpath: value => value === ROOT ? '/outside/private' : value } });
  await assert.rejects(h.source.sample(request()), { code: 'INVALID_SCOPE' });
  assert.equal(h.spawns.length, 0);
});

test('out-of-root and sibling-prefix documents lose path AND title without probing that external file', async t => {
  for (const location of ['/outside/private.docx', `${ROOT}2/private.docx`]) {
    const h = harness(t, { value: sample({ document: { path: location, title: 'PRIVATE TITLE MUST NOT LEAK' } }) });
    const result = await h.source.sample(request());
    assert.deepEqual(result.app, sample().app);
    assert.equal(result.document, undefined);
    assert.equal(result.reason, 'DOCUMENT_OUT_OF_SCOPE');
    assert.ok(!h.fileSystem.calls.some(([, file]) => file === location));
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('symlink swap or non-regular document strips all document data', async t => {
  const h = harness(t, { fs: { realpath: value => value === DOC ? '/outside/private.docx' : value } });
  assert.equal((await h.source.sample(request())).document, undefined);
  const irregular = harness(t, { fs: { regular: false } });
  assert.equal((await irregular.source.sample(request())).document, undefined);
});

test('a root swapped after native response cannot authorize its old document', async t => {
  let checks = 0;
  const h = harness(t, { fs: { realpath: value => value === ROOT && ++checks > 1 ? '/outside/private' : value } });
  const result = await h.source.sample(request());
  assert.equal(result.document, undefined);
  assert.equal(result.reason, 'DOCUMENT_OUT_OF_SCOPE');
});

test('response schema rejects unselected apps, body/selection fields, malformed protocol and unsafe file kinds', async t => {
  const values = [sample({ app: { ...EDGE } }),
    sample({ app: { ...WORD, name: 'unsafe\nname' } }), sample({ app: { ...WORD, name: '\ud800' } }),
    sample({ app: { ...WORD, name: 'x'.repeat(257) } }), sample({ app: { ...WORD, body: 'private' } }),
    sample({ app: { ...WORD, pid: 0 } }), sample({ document: { path: DOC, title: 'ok', body: 'private' } }),
    sample({ selectedText: 'private' }), sample({ document: { path: `${ROOT}/run.command`, title: 'run' } }),
    sample({ document: { path: DOC, title: 'line\nprivate' } }), sample({ app: null }),
    { ...sample(), v: 2 }, { ...sample(), observedAt: 'never' }, { ...sample(), reason: 'unbounded private failure' }];
  for (const value of values) {
    const h = harness(t, { value });
    await assert.rejects(h.source.sample(request()), { code: 'INVALID_SOURCE_RESPONSE' });
  }
});

test('status rejects non-catalog applications instead of leaking discovery or treating it as usage history', async t => {
  const h = harness(t, { value: status({ applications: [{ id: 'private.app', name: 'private', installed: true }] }) });
  await assert.rejects(h.source.status(), { code: 'INVALID_SOURCE_RESPONSE' });
});

test('native program path must not be symlinked or oversized', async t => {
  for (const fs of [{ scriptSymlink: true }, { scriptSize: 65537 }]) {
    const h = harness(t, { fs });
    await assert.rejects(h.source.status(), { code: 'INVALID_SOURCE_PROGRAM' });
    assert.equal(h.spawns.length, 0);
  }
});

test('JSON protocol is singular and bounded; large stdout/stderr terminate the managed child', async t => {
  const malformed = harness(t, { raw: '{}\n{}' });
  await assert.rejects(malformed.source.status(), { code: 'INVALID_SOURCE_RESPONSE' });
  for (const stream of ['stdout', 'stderr']) {
    const h = harness(t, { auto: false });
    const pending = h.source.status();
    await turn();
    h.children[0][stream].write(Buffer.alloc(40000, 65));
    await assert.rejects(pending, { code: 'SOURCE_OUTPUT_LIMIT' });
    assert.ok(h.children[0].terminations > 0);
  }
});

test('timeout and explicit cancellation terminate and join; late reply is never admitted', async t => {
  const h = harness(t, { auto: false, timeoutMs: 15 });
  await assert.rejects(h.source.sample(request()), { code: 'SOURCE_TIMEOUT' });
  assert.ok(h.children[0].terminations > 0);
  assert.ok(h.children[0].waits > 0);
  const other = harness(t, { auto: false });
  const controller = new AbortController();
  const pending = other.source.sample({ ...request(), signal: controller.signal });
  await turn();
  const reason = new DOMException('cancel test', 'AbortError');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.ok(other.children[0].terminations > 0);
  other.children[0].raw(JSON.stringify(sample()));
});

test('cancel during program loading cannot produce a late child', async t => {
  const held = deferred(), fileSystem = fixtureFS();
  const realpath = fileSystem.realpath;
  fileSystem.realpath = value => value === PARENT ? held.promise : realpath(value);
  const h = harness(t, { fileSystem });
  const controller = new AbortController();
  const pending = h.source.status({ signal: controller.signal });
  await turn(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  held.resolve(PARENT); await turn();
  assert.equal(h.spawns.length, 0);
});

test('post-response filesystem verification obeys the same deadline and disposal barrier', async t => {
  const held = deferred(), fileSystem = fixtureFS();
  const realpath = fileSystem.realpath;
  fileSystem.realpath = value => value === DOC ? held.promise : realpath(value);
  const h = harness(t, { fileSystem, timeoutMs: 15 });
  await assert.rejects(h.source.sample(request()), { code: 'SOURCE_TIMEOUT' });
  const other = harness(t, { fileSystem });
  const pending = other.source.sample(request());
  await turn();
  await other.source.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  held.resolve(DOC);
});

test('lifecycle abort joins all active managed ranges and dispose is idempotent', async t => {
  const h = harness(t, { auto: false });
  const first = h.source.status(), second = h.source.sample(request());
  void first.catch(() => {}); void second.catch(() => {});
  await turn();
  const stopped = h.source.dispose();
  assert.equal(stopped, h.source.dispose());
  await stopped;
  await assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(second, { name: 'AbortError' });
  assert.ok(h.children.every(child => child.terminations > 0 && child.waits > 0));
  await assert.rejects(h.source.status(), { code: 'SOURCE_DISPOSED' });
});

test('unobservable process-range cleanup poisons future reads rather than pretending stopped', async t => {
  const h = harness(t, { auto: false, timeoutMs: 10, cleanupMs: 5, child: { ignoreWait: true, ignoreTerminate: true } });
  await assert.rejects(h.source.status(), { code: 'SOURCE_STOP_FAILED' });
  await assert.rejects(h.source.sample(request()), { code: 'SOURCE_STOP_FAILED' });
  await assert.rejects(h.source.discoverApplications(), { code: 'SOURCE_STOP_FAILED' });
  await assert.rejects(h.source.dispose(), { code: 'SOURCE_STOP_FAILED' });
});

test('spawn/provider failures are redacted and cannot copy private stderr/error strings into result', async t => {
  const h = harness(t, { spawnError: new Error('/private/file.docx token=PRIVATE') });
  await assert.rejects(h.source.status(), error => error.code === 'SOURCE_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  const other = harness(t, { auto: false });
  const pending = other.source.status(); await turn();
  other.children[0].fail(new Error('/private/file.docx token=PRIVATE'));
  await assert.rejects(pending, error => error.code === 'SOURCE_UNAVAILABLE' && !error.message.includes('PRIVATE'));
});

test('explicit dynamic selection supports Edge, Feishu and reverse-DNS IDs, without implicit metadata consent', async t => {
  for (const app of [EDGE, FEISHU, { id: 'org.Example-work.App_2', name: '工作 📚' }]) {
    const h = harness(t, { value: appSnapshot(app) });
    assert.deepEqual((await h.source.sample({ applications: [app.id], roots: [] })).app, { ...app, pid: 42 });
    assert.deepEqual(JSON.parse(h.spawns[0].argv.at(-1)).contextApplications, []);
  }
});

test('context selections are unique, bounded, and a strict subset of selected app IDs', async t => {
  const h = harness(t);
  for (const contextApplications of [[FEISHU.id], [EDGE.id, EDGE.id], null, 'all', ['invalid'], Array(1),
    Array.from({ length: 129 }, (_, i) => `org.example.app${i}`)]) {
    await assert.rejects(h.source.sample({ applications: [EDGE.id], contextApplications, roots: [] }),
      { code: Array.isArray(contextApplications) && contextApplications.length === 1 && contextApplications[0] === FEISHU.id ? 'INVALID_CONTEXT_APPLICATIONS' : 'INVALID_APPLICATIONS' });
  }
  assert.equal(h.spawns.length, 0);
});

test('private request budget accommodates 128 selected plus 128 consent IDs at their 255-character bound', async t => {
  const applications = Array.from({ length: 128 }, (_, i) => `org.${String(i).padStart(3, '0')}.${'x'.repeat(247)}`);
  assert.ok(applications.every(id => id.length === 255));
  const app = { id: applications[0], name: 'App' };
  const h = harness(t, { value: appSnapshot(app) });
  assert.equal((await h.source.sample({ applications, contextApplications: applications, roots: [] })).app.id, app.id);
  assert.ok(Buffer.byteLength(h.spawns[0].argv.at(-1)) > 16384);
  assert.ok(Buffer.byteLength(h.spawns[0].argv.at(-1)) <= 131072);
});

test('application discovery is a separate explicit managed action, never a status side effect', async t => {
  const h = harness(t);
  await h.source.status();
  const result = await h.source.discoverApplications();
  await h.source.status();
  assert.deepEqual(result, discovery([FEISHU, EDGE])); // lexicographic bundle IDs
  assert.deepEqual(h.spawns.map(spec => JSON.parse(spec.argv.at(-1)).action), ['status', 'applications', 'status']);
  assert.deepEqual(JSON.parse(h.spawns[1].argv.at(-1)), { v: 1, action: 'applications' });
  assert.deepEqual(h.spawns[1].stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  assert.equal(h.spawns[1].env.TOKEN, undefined);
  assert.equal(MAC_ACTIVITY_APPLICATIONS.length, 3);
});

test('discovery rejects malformed identities, duplicate IDs, extra metadata, invalid flags and oversized lists', async t => {
  const valid = discovery([EDGE]).applications[0];
  const values = [
    discovery([], { applications: [{ ...valid, id: 'bad id' }] }),
    discovery([], { applications: [{ ...valid, name: 'bad\nname' }] }),
    discovery([], { applications: [{ ...valid, name: '\udfff' }] }),
    discovery([], { applications: [{ ...valid, name: 'x'.repeat(257) }] }),
    discovery([], { applications: [{ ...valid, installed: false }] }),
    discovery([], { applications: [{ ...valid, running: false }] }),
    discovery([], { applications: [{ ...valid, window: { title: 'private' } }] }),
    discovery([EDGE, EDGE]), discovery(Array.from({ length: 129 }, (_, i) => ({ id: `org.example.app${i}`, name: 'App' }))),
    discovery([], { truncated: 'yes' }), discovery([], { platform: 'linux' }), discovery([], { v: 2 }),
  ];
  for (const value of values) {
    const h = harness(t, { value });
    await assert.rejects(h.source.discoverApplications(), { code: 'INVALID_SOURCE_RESPONSE' });
  }
  const other = harness(t, { platform: 'linux' });
  await assert.rejects(other.source.discoverApplications(), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(other.spawns.length, 0);
});

test('a selected app still cannot return unconsented window metadata, even when another selected app has consent', async t => {
  for (const contextApplications of [undefined, [], [FEISHU.id]]) {
    const h = harness(t, { value: appSnapshot(EDGE, { window: { title: 'PRIVATE WINDOW', url: 'https://example.com/' } }) });
    await assert.rejects(h.source.sample({ applications: [EDGE.id, FEISHU.id], contextApplications, roots: [] }), { code: 'INVALID_SOURCE_RESPONSE' });
  }
});

test('consented window hints sanitize Unicode titles and HTTPS metadata independently of document roots', async t => {
  const h = harness(t, { value: appSnapshot(FEISHU, { window: { title: '  计划\n📚\ud800  ', url: 'https://EXAMPLE.com:443/a/../work?q=PRIVATE#TOKEN' } }) });
  const result = await h.source.sample(contextRequest(FEISHU));
  assert.deepEqual(result.window, { title: '计划📚', url: 'https://example.com/work' });
  assert.equal(result.app.name, FEISHU.name);
  assert.equal(result.document, undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes('TOKEN'));
  assert.deepEqual(JSON.parse(h.spawns[0].argv.at(-1)).contextApplications, [FEISHU.id]);
});

test('host URL gate rejects schemes, userinfo, local/IP hosts and control characters instead of fabricating links', async t => {
  for (const url of ['http://example.com/', 'file:///private/report', 'javascript:alert(1)', 'data:text/plain,secret',
    'https://user:pass@example.com/', 'https://@example.com/', 'https://localhost/', 'https://x.localhost/', 'https://host.local/',
    'https://example.local./', 'https://127.0.0.1/', 'https://8.8.8.8/', 'https://127.1/', 'https://2130706433/',
    'https://0x7f000001/', 'https://0177.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://example.com/a\nb', 'https://example.com/a%00b', 'https://example.com/%C0%AF', 'https://example.com/\\@private',
    'https://example.com/\ud800', 'https://intranet/']) {
    const h = harness(t, { value: appSnapshot(EDGE, { window: { title: 'Safe title', url } }) });
    assert.deepEqual((await h.source.sample(contextRequest())).window, { title: 'Safe title' }, url);
  }
  const none = harness(t, { value: appSnapshot(EDGE, { window: { url: 'javascript:alert(1)' } }) });
  assert.equal((await none.source.sample(contextRequest())).window, undefined);
});

test('window wire schema cannot smuggle body, selected text, unknown fields or unbounded values', async t => {
  for (const window of [{ title: 'ok', body: 'private' }, { title: 'ok', selectedText: 'private' },
    { title: 'ok', AXValue: 'private' }, { title: 7 }, { url: {} }, { title: 'x'.repeat(513) }, { url: `https://example.com/${'x'.repeat(2048)}` }]) {
    const h = harness(t, { value: appSnapshot(EDGE, { window }) });
    await assert.rejects(h.source.sample(contextRequest()), { code: 'INVALID_SOURCE_RESPONSE' });
  }
  const nulled = harness(t, { value: { v: 1, observedAt: TIME, app: null, window: { title: 'private' } } });
  await assert.rejects(nulled.source.sample(contextRequest()), { code: 'INVALID_SOURCE_RESPONSE' });
});

test('root revocation drops document path/title but does not revoke separately consented window metadata', async t => {
  const outside = '/outside/private.docx';
  const h = harness(t, { value: appSnapshot(EDGE, { document: { path: outside, title: 'PRIVATE DOCUMENT' },
    window: { title: 'Allowed by context consent', url: 'https://example.com/report?private=1#private' } }) });
  const result = await h.source.sample(contextRequest(EDGE, { roots: [ROOT] }));
  assert.equal(result.document, undefined); assert.equal(result.reason, 'DOCUMENT_OUT_OF_SCOPE');
  assert.deepEqual(result.window, { title: 'Allowed by context consent', url: 'https://example.com/report' });
  assert.ok(!h.fileSystem.calls.some(([, file]) => file === outside));
});

test('uncertain focus/source failures preserve known app but strip every document/window field', async t => {
  for (const reason of ['FOCUS_CHANGED', 'SOURCE_UNAVAILABLE']) {
    const h = harness(t, { value: sample({ reason, window: { title: 'STALE', url: 'https://example.com/' } }) });
    const result = await h.source.sample({ ...request(), contextApplications: [WORD.id] });
    assert.deepEqual(result.app, { ...WORD, pid: 42 });
    assert.equal(result.reason, reason); assert.equal(result.document, undefined); assert.equal(result.window, undefined);
    assert.ok(!h.fileSystem.calls.some(([, file]) => file === DOC));
  }
});

test('local document metadata extension support matches document search kinds, without accepting executable files', async t => {
  for (const extension of ['doc', 'docx', 'ppt', 'pptx', 'rtf', 'xlsx', 'xls', 'csv', 'pdf', 'txt', 'md']) {
    const location = `${ROOT}/report.${extension}`;
    const h = harness(t, { value: sample({ document: { path: location, title: 'Local title 📄' } }) });
    assert.deepEqual((await h.source.sample(request())).document, { path: location, title: 'Local title 📄' });
  }
});

test('UTF-8 protocol decoding is fatal, not replacement-decoded into a seemingly valid app label', async t => {
  const [first, last] = JSON.stringify(appSnapshot(EDGE, { app: { ...EDGE, name: 'BAD_UTF8' } })).split('BAD_UTF8');
  const h = harness(t, { raw: Buffer.concat([Buffer.from(first), Buffer.from([0xc3, 0x28]), Buffer.from(last)]) });
  await assert.rejects(h.source.sample({ applications: [EDGE.id], roots: [] }), { code: 'INVALID_SOURCE_RESPONSE' });
});

test('discovery cancellation shares managed termination, join and late-output barriers', async t => {
  const h = harness(t, { auto: false }), controller = new AbortController();
  const pending = h.source.discoverApplications({ signal: controller.signal });
  await turn(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(h.children[0].terminations > 0); assert.ok(h.children[0].waits > 0);
  h.children[0].raw(JSON.stringify(discovery([EDGE])));
});

// Execute the actual static JXA source with an entirely fake ObjC/AX bridge. This verifies
// policy ordering, NOT real macOS compatibility. No native functions are imported/called.
const jxaSource = await readFile(new URL('../native/context-reader.js', import.meta.url), 'utf8');
function fakeJXA(options = {}) {
  const attributes = [], calls = { frontmost: 0, discovery: 0, axCreate: 0, axTrust: 0, imports: [], names: [], reads: [],
    timeouts: [], childCounts: [], childSlices: [], fileChecks: [], fileStats: [], installs: [] };
  let clock = 0, focusReads = 0;
  const boxed = value => ({ value, get stringByStandardizingPath() { return boxed(path.posix.normalize(value)); },
    get stringByResolvingSymlinksInPath() { return boxed(options.aliases?.[value] || value); } });
  const unwrap = value => value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
  const dollar = (...args) => args.length === 0 ? [] : boxed(args[0]);
  const known = MAC_ACTIVITY_APPLICATIONS.find(app => app.id === (options.app ?? WORD.id));
  const front = { bundleIdentifier: options.app ?? WORD.id, processIdentifier: options.pid ?? 42, isNil: () => false,
    get localizedName() {
      calls.names.push(options.app ?? WORD.id);
      if (options.nameError) throw new Error('display name unavailable');
      return options.name ?? known?.name ?? (options.app === EDGE.id ? EDGE.name : options.app === FEISHU.id ? FEISHU.name : 'FAKE APP');
    } };
  const window = { kind: 'window', role: 'AXWindow', children: options.tree ?? [] };
  const nativeApp = { kind: 'app' }, otherWindow = { kind: 'other-window', role: 'AXWindow' };
  const workspace = { URLForApplicationWithBundleIdentifier(id) { calls.installs.push(unwrap(id)); return { isNil: () => false }; },
    get runningApplications() {
      calls.discovery++;
      if (options.discoveryError) throw new Error('discovery unavailable');
      return options.running ?? [];
    },
    get frontmostApplication() {
      calls.frontmost++;
      if (options.frontError === true || options.frontError === 'late' && calls.frontmost > 1) throw new Error('private native failure');
      if (options.noFront) return { isNil: () => true };
      if (options.frontSequence) return options.frontSequence[Math.min(calls.frontmost - 1, options.frontSequence.length - 1)];
      if (options.focusRace && calls.frontmost > 1) return { bundleIdentifier: front.bundleIdentifier, processIdentifier: 99, isNil: () => false };
      return front;
    } };
  function axResult(key, element) { clock += options.axStepMs ?? 0; return options.axError?.(key, element) ?? 0; }
  Object.assign(dollar, {
    NSWorkspace: { sharedWorkspace: workspace }, NSProcessInfo: { processInfo: { get systemUptime() { return clock / 1000; } } },
    AXIsProcessTrusted() { calls.axTrust++; return options.trusted !== false; },
    AXUIElementCreateApplication() { calls.axCreate++; if (options.createError) throw new Error('AX unavailable'); return nativeApp; },
    AXUIElementSetMessagingTimeout(element, seconds) { calls.timeouts.push({ element, seconds }); return options.timeoutError ?? 0; },
    AXUIElementCopyAttributeValue(element, name, ref) {
      const key = unwrap(name); attributes.push(key); calls.reads.push({ element, key });
      const code = axResult(key, element); if (code !== 0) return code;
      if (key === 'AXFocusedWindow') {
        assert.equal(element, nativeApp); focusReads++;
        if (options.noWindow || options.recheckMissing && focusReads > 1) return -25212;
        ref[0] = options.windowRace && focusReads > 1 ? otherWindow : window;
      } else if (key === 'AXDocument') {
        assert.equal(element, window); if (options.noDocument) return -25212; ref[0] = options.document ?? `file://${DOC}`;
      } else if (key === 'AXTitle') {
        assert.equal(element, window, 'only the selected focused window title may be read'); ref[0] = options.title ?? 'FAKE TITLE';
      } else if (key === 'AXURL') {
        assert.ok(element === window || element.role === 'AXWebArea', 'never read URLs from address bars, links or arbitrary nodes');
        const value = element === window ? options.windowUrl : element.url;
        if (value === undefined) return -25212; ref[0] = value;
      } else if (key === 'AXRole') ref[0] = element.role;
      else throw new Error(`forbidden attribute ${key}`);
      return 0;
    },
    AXUIElementGetAttributeValueCount(element, name, ref) {
      assert.equal(unwrap(name), 'AXChildren'); calls.childCounts.push(element);
      const code = axResult('AXChildren:count', element); if (code !== 0) return code;
      ref[0] = options.childCount?.(element) ?? element.children?.length ?? 0; return 0;
    },
    AXUIElementCopyAttributeValues(element, name, start, count, ref) {
      assert.equal(unwrap(name), 'AXChildren'); assert.equal(start, 0); assert.ok(count <= 48);
      calls.childSlices.push({ element, count });
      const code = axResult('AXChildren:slice', element); if (code !== 0) return code;
      const values = (element.children ?? []).slice(0, options.incompleteChildren ? Math.max(0, count - 1) : count);
      ref[0] = options.nativeArrays ? { count: values.length, objectAtIndex: index => values[index] } : values; return 0;
    },
    CFEqual(a, b) { if (options.equalError) throw new Error('cannot compare'); return a === b; },
    CFGetTypeID(value) { return value?.cfUrl ? 7 : 0; }, CFURLGetTypeID: () => 7, CFURLGetString: value => value.cfUrl,
    NSURL: { URLWithString(value) { const url = new URL(unwrap(value)); return { isNil: () => false, isFileURL: url.protocol === 'file:', host: url.hostname,
      path: decodeURIComponent(url.pathname) }; } },
    NSFileType: 'NSFileType', NSFileTypeRegular: 'NSFileTypeRegular',
    NSFileManager: { defaultManager: { fileExistsAtPathIsDirectory(file, ref) { calls.fileChecks.push(unwrap(file)); ref[0] = false; return true; },
      attributesOfItemAtPathError(file) { calls.fileStats.push(unwrap(file)); return { isNil: () => false, objectForKey: () => options.irregular ? 'NSFileTypeDirectory' : 'NSFileTypeRegular' }; } } },
  });
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [TIME])); } static now() { return clock; } }
  const context = vm.createContext({ ObjC: { import(name) { calls.imports.push(name); }, unwrap }, $: dollar, Ref: () => [], Date: ClockDate, console: undefined });
  vm.runInContext(jxaSource, context, { timeout: 1000 });
  return { attributes, calls, known, window, nativeApp, advance: ms => { clock += ms; }, get elapsed() { return clock; },
    run: payload => JSON.parse(context.run([JSON.stringify(payload)])), runArgs: argv => JSON.parse(context.run(argv)) };
}

test('fake JXA: status never reads foreground and denied AX still permits selected app-only metadata', () => {
  const native = fakeJXA({ trusted: false });
  const result = native.run({ v: 1, action: 'status' });
  assert.equal(result.available, true); assert.equal(result.accessibilityTrusted, false);
  assert.equal(native.calls.frontmost, 0); assert.equal(native.calls.discovery, 0); assert.deepEqual(native.calls.names, []); assert.deepEqual(native.attributes, []);
  const appOnly = native.run({ v: 1, action: 'sample', ...request() });
  assert.deepEqual(appOnly.app, { ...WORD, pid: 42 });
  assert.equal(appOnly.document, undefined);
  assert.equal(appOnly.reason, 'accessibility_required_for_documents');
  assert.equal(native.calls.axCreate, 0); assert.deepEqual(native.attributes, []);
});

test('fake JXA: scope is checked before the first title read; no full tree/body/selected text ever read', () => {
  const outside = fakeJXA({ document: 'file:///outside/private.docx' });
  const rejected = outside.run({ v: 1, action: 'sample', ...request() });
  assert.equal(rejected.document, undefined);
  assert.equal(rejected.reason, 'DOCUMENT_OUT_OF_SCOPE');
  assert.deepEqual(outside.attributes, ['AXFocusedWindow', 'AXDocument']);
  const safe = fakeJXA();
  assert.deepEqual(safe.run({ v: 1, action: 'sample', ...request() }).document, { path: DOC, title: 'FAKE TITLE' });
  assert.deepEqual(safe.attributes, ['AXFocusedWindow', 'AXDocument', 'AXTitle', 'AXFocusedWindow']);
  assert.deepEqual(safe.calls.childCounts, []); assert.deepEqual(safe.calls.childSlices, []);
});

test('fake JXA: missing path, symlink escape, remote URL, unselected Edge and focus races cannot expose titles', () => {
  for (const options of [{ noDocument: true }, { aliases: { [DOC]: '/outside/private.docx' } }, { document: 'https://private.example/report.docx' },
    { document: 'file://remote/private/report.docx' }, { document: `file://${ROOT}/run.command` }]) {
    const native = fakeJXA(options);
    assert.equal(native.run({ v: 1, action: 'sample', ...request() }).document, undefined);
    assert.ok(!native.attributes.includes('AXTitle'));
  }
  const edge = fakeJXA({ app: 'com.microsoft.edgemac' });
  assert.equal(edge.run({ v: 1, action: 'sample', ...request() }).app, null);
  assert.deepEqual(edge.attributes, []); assert.deepEqual(edge.calls.names, []);
  const race = fakeJXA({ focusRace: true });
  const raced = race.run({ v: 1, action: 'sample', ...request() });
  assert.deepEqual(raced.app, { ...WORD, pid: 42 }); assert.equal(raced.document, undefined); assert.equal(raced.reason, 'FOCUS_CHANGED');
});

test('fake JXA: malformed args cannot become script input; only Cocoa and ApplicationServices imported', () => {
  const native = fakeJXA();
  assert.equal(native.run({ v: 1, action: 'eval', code: 'evil()' }).error, 'SOURCE_UNAVAILABLE');
  assert.deepEqual(native.calls.imports, ['Cocoa', 'ApplicationServices']);
  assert.ok(!/Application\(['"]System Events/u.test(jxaSource));
  assert.ok(!/doShellScript|AXUIElementPerformAction|AXUIElementSetAttributeValue|AXIsProcessTrustedWithOptions\s*\(/u.test(jxaSource));
});

test('stderr remains bounded after stdout EOF while the managed child has not exited', async t => {
  const h = harness(t, { auto: false }); const pending = h.source.status();
  await turn(); const child = h.children[0];
  child.raw(JSON.stringify(status())); child.stdout.end(); await turn();
  child.stderr.write(Buffer.alloc(40000, 65));
  await assert.rejects(pending, { code: 'SOURCE_OUTPUT_LIMIT' }); assert.ok(child.terminations > 0);
});

test('fake JXA: no approved document folders means zero AX getters even when permission exists', () => {
  const native = fakeJXA({ trusted: true });
  const result = native.run({ v: 1, action: 'sample', applications: [WORD.id], roots: [] });
  assert.equal(result.app.id, WORD.id); assert.equal(result.document, undefined); assert.equal(result.window, undefined);
  assert.equal(native.calls.axCreate, 0); assert.equal(native.calls.axTrust, 0); assert.deepEqual(native.attributes, []);
  assert.deepEqual(native.calls.childCounts, []);
});

const runningApp = (id, name, activationPolicy = 0, extra = {}) => ({ bundleIdentifier: id, localizedName: name, activationPolicy, terminated: false, ...extra });

test('fake JXA: explicit discovery uses running GUI identities only, sorted/deduped with zero AX or window reads', () => {
  let forbiddenNames = 0;
  const background = { activationPolicy: 2, bundleIdentifier: 'org.example.background',
    get localizedName() { forbiddenNames++; throw new Error('not a GUI app'); } };
  const native = fakeJXA({ running: [runningApp(EDGE.id, EDGE.name), runningApp(FEISHU.id, FEISHU.name, 1),
    runningApp(EDGE.id, 'ZZ duplicate'), background,
    runningApp('bad id', 'Invalid'), runningApp('org.example.exited', 'Exited', 0, { terminated: true })] });
  const result = native.run({ v: 1, action: 'applications' });
  // Feishu is an accessory (policy 1) agent here, Edge is regular: both are selectable
  // but only the regular one is foreground-capable, so the UI can hide the rest.
  assert.deepEqual(result, discovery([{ ...FEISHU, foreground: false }, { ...EDGE, foreground: true }]));
  assert.equal(native.calls.discovery, 1); assert.equal(native.calls.frontmost, 0);
  assert.equal(native.calls.axCreate, 0); assert.equal(native.calls.axTrust, 0); assert.deepEqual(native.attributes, []);
  assert.deepEqual(native.calls.childCounts, []); assert.deepEqual(native.calls.installs, []);
  assert.equal(forbiddenNames, 0);
  native.run({ v: 1, action: 'status' });
  assert.equal(native.calls.discovery, 1); assert.equal(native.calls.frontmost, 0);
  assert.equal(native.calls.installs.length, 3);
});

test('fake JXA: discovery cap and UTF-8 byte budget return partial results with truncated=true, not overflowing IPC', () => {
  const all = Array.from({ length: 129 }, (_, i) => runningApp(`org.example.app${String(i).padStart(3, '0')}`, `软件 ${i}`));
  const capped = fakeJXA({ running: all }).run({ v: 1, action: 'applications' });
  assert.equal(capped.applications.length, 128); assert.equal(capped.truncated, true);
  const long = Array.from({ length: 128 }, (_, i) => runningApp(`org.${String(i).padStart(3, '0')}.${'x'.repeat(247)}`, '中'.repeat(254) + '🐦'));
  const bounded = fakeJXA({ running: long }).run({ v: 1, action: 'applications' });
  assert.equal(bounded.truncated, true); assert.ok(bounded.applications.length > 0 && bounded.applications.length < 128);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 32768);
  assert.ok(bounded.applications.every(app => app.name.length <= 256 && app.name.isWellFormed()));
});

test('fake JXA: explicit discovery has scan-count and wall-clock bounds, without AX fallback on failure', () => {
  let scans = 0;
  const running = Array.from({ length: 1100 }, (_, i) => ({ bundleIdentifier: `org.example.app${i}`, localizedName: 'App',
    get activationPolicy() { scans++; return 0; } }));
  const countBounded = fakeJXA({ running });
  assert.equal(countBounded.run({ v: 1, action: 'applications' }).truncated, true); assert.equal(scans, 1024);
  let timed;
  timed = fakeJXA({ running: [{ bundleIdentifier: EDGE.id, activationPolicy: 0,
    get localizedName() { timed.advance(901); return EDGE.name; } }, runningApp(FEISHU.id, FEISHU.name)] });
  const result = timed.run({ v: 1, action: 'applications' });
  assert.equal(result.truncated, true); assert.equal(result.applications.length, 1); assert.equal(timed.calls.axTrust, 0);
  const unavailable = fakeJXA({ discoveryError: true });
  assert.equal(unavailable.run({ v: 1, action: 'applications' }).error, 'SOURCE_UNAVAILABLE');
  assert.equal(unavailable.calls.axCreate, 0); assert.equal(unavailable.calls.frontmost, 0);
});

test('fake JXA: selected Edge/Feishu app identity works with metadata consent OFF, without any AX calls', () => {
  for (const app of [EDGE, FEISHU]) {
    const native = fakeJXA({ app: app.id });
    const result = native.run({ v: 1, action: 'sample', applications: [app.id], roots: [] });
    assert.deepEqual(result.app, { ...app, pid: 42 });
    assert.equal(result.document, undefined); assert.equal(result.window, undefined);
    assert.equal(native.calls.axTrust, 0); assert.equal(native.calls.axCreate, 0); assert.deepEqual(native.attributes, []);
    assert.deepEqual(native.calls.names, [app.id]);
  }
  const otherConsent = fakeJXA({ app: EDGE.id });
  const value = otherConsent.run({ v: 1, action: 'sample', applications: [EDGE.id, FEISHU.id], contextApplications: [FEISHU.id], roots: [] });
  assert.equal(value.app.id, EDGE.id); assert.equal(value.window, undefined); assert.equal(otherConsent.calls.axTrust, 0);
});

test('fake JXA: selected app localizedName is sanitized and normal emoji survive, unselected names remain unread', () => {
  for (const [name, expected] of [[' 飞书\n🐦\ud800 ', '飞书🐦'], ['x'.repeat(255) + '🐦', 'x'.repeat(255)], ['\u0000', FEISHU.id]]) {
    const native = fakeJXA({ app: FEISHU.id, name });
    const result = native.run({ v: 1, action: 'sample', applications: [FEISHU.id], roots: [] });
    assert.equal(result.app.name, expected); assert.ok(result.app.name.isWellFormed()); assert.ok(result.app.name.length <= 256);
  }
  const unselected = fakeJXA({ app: EDGE.id, nameError: true });
  assert.equal(unselected.run({ v: 1, action: 'sample', ...request() }).reason, 'APP_NOT_ALLOWED');
  assert.deepEqual(unselected.calls.names, []); assert.deepEqual(unselected.attributes, []);
});

test('fake JXA: consented focused-window AXDocument URL is preferred, sanitized before IPC, and does not need local roots', () => {
  const native = fakeJXA({ app: EDGE.id, document: 'https://EXAMPLE.com:443/work?q=PRIVATE#FRAGMENT', windowUrl: 'https://other.example/private', title: '工作 📄' });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest() });
  assert.deepEqual(result.window, { title: '工作 📄', url: 'https://example.com/work' });
  assert.equal(result.document, undefined); assert.deepEqual(native.calls.fileChecks, []);
  assert.deepEqual(native.attributes, ['AXFocusedWindow', 'AXDocument', 'AXTitle', 'AXFocusedWindow']);
  assert.deepEqual(native.calls.childCounts, []);
  const cf = fakeJXA({ app: FEISHU.id, document: { cfUrl: 'https://docs.example.com/note?private=1#private' } });
  assert.equal(cf.run({ v: 1, action: 'sample', ...contextRequest(FEISHU) }).window.url, 'https://docs.example.com/note');
});

test('fake JXA: AXURL of the focused window supports embedded apps without reading address-bar text', () => {
  const native = fakeJXA({ app: FEISHU.id, noDocument: true, windowUrl: 'https://docs.example.com/note?private=1#private', title: '文档\n🐦\ud800' });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest(FEISHU) });
  assert.deepEqual(result.window, { title: '文档🐦', url: 'https://docs.example.com/note' });
  assert.deepEqual(native.attributes, ['AXFocusedWindow', 'AXDocument', 'AXTitle', 'AXURL', 'AXFocusedWindow']);
  assert.deepEqual(native.calls.childCounts, []); assert.deepEqual(native.calls.childSlices, []);
});

test('fake JXA: default-off metadata consent preserves the local-root-before-title boundary for selected browsers too', () => {
  const native = fakeJXA({ app: EDGE.id, document: 'https://docs.example.com/private?token=secret' });
  const result = native.run({ v: 1, action: 'sample', applications: [EDGE.id], roots: [ROOT] });
  assert.equal(result.app.id, EDGE.id); assert.equal(result.document, undefined); assert.equal(result.window, undefined);
  assert.deepEqual(native.attributes, ['AXFocusedWindow', 'AXDocument']); assert.deepEqual(native.calls.childCounts, []);
});

test('fake JXA: independent context consent may return title/HTTPS hints for an out-of-root file but never its path', () => {
  const native = fakeJXA({ app: FEISHU.id, document: 'file:///outside/private.docx', windowUrl: 'https://docs.example.com/work?secret=1', title: 'Consented title' });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest(FEISHU, { roots: [ROOT] }) });
  assert.deepEqual(result.window, { title: 'Consented title', url: 'https://docs.example.com/work' });
  assert.equal(result.document, undefined); assert.deepEqual(native.calls.fileChecks, []); assert.deepEqual(native.calls.fileStats, []);
  const changedRoot = fakeJXA({ aliases: { [ROOT]: '/outside/private' } });
  assert.equal(changedRoot.run({ v: 1, action: 'sample', ...request() }).reason, 'INVALID_SCOPE');
  assert.deepEqual(changedRoot.attributes, []); assert.equal(changedRoot.calls.axCreate, 0);
});

test('fake JXA: WebArea fallback is role-only, focused-window-only and never descends body, link or text controls', () => {
  const body = { role: 'AXStaticText', url: 'https://private.example/body' };
  const web = { role: 'AXWebArea', url: 'https://docs.example.com/project?q=private#private', children: [body] };
  const text = { role: 'AXTextField', url: 'https://private.example/typed', children: [{ role: 'AXWebArea', url: 'https://private.example/typed' }] };
  const link = { role: 'AXLink', url: 'https://private.example/link', children: [] };
  const native = fakeJXA({ app: FEISHU.id, noDocument: true, tree: [text, link, { role: 'AXGroup', children: [{ role: 'AXScrollArea', children: [web] }] }] });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest(FEISHU) });
  assert.equal(result.window.url, 'https://docs.example.com/project');
  assert.ok(!native.calls.childCounts.includes(text)); assert.ok(!native.calls.childCounts.includes(link)); assert.ok(!native.calls.childCounts.includes(web));
  assert.ok(!native.calls.reads.some(read => read.element === body));
  assert.ok(native.calls.reads.every(({ element, key }) => key !== 'AXURL' || element === native.window || element === web));
  assert.ok(native.attributes.every(name => ['AXFocusedWindow', 'AXDocument', 'AXTitle', 'AXURL', 'AXRole'].includes(name)));
});

test('fake JXA: role traversal has a hard 48-node cap and bounded child slices, never fetching a whole AXChildren array', () => {
  const tree = Array.from({ length: 99 }, () => ({ role: 'AXGroup', children: [] }));
  const hidden = { role: 'AXWebArea', url: 'https://private.example/outside-cap' }; tree.push(hidden);
  const native = fakeJXA({ app: EDGE.id, noDocument: true, tree });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest() });
  assert.deepEqual(result.app, { ...EDGE, pid: 42 }); assert.equal(result.document, undefined);
  // The verified title survives a capped traversal; no URL is invented from the hidden node.
  assert.deepEqual(result.window, { title: 'FAKE TITLE' });
  assert.equal(native.attributes.filter(key => key === 'AXRole').length, 48);
  assert.equal(native.calls.childSlices[0].count, 47); assert.ok(native.calls.childSlices.every(slice => slice.count <= 48));
  assert.ok(!native.attributes.includes('AXChildren')); assert.ok(!native.calls.reads.some(read => read.element === hidden));
});

test('fake JXA: role traversal stops at depth 5 without reading a deeper WebArea URL', () => {
  const hidden = { role: 'AXWebArea', url: 'https://private.example/too-deep' };
  let branch = hidden;
  for (let i = 0; i < 6; i++) branch = { role: 'AXGroup', children: [branch] };
  const native = fakeJXA({ app: EDGE.id, noDocument: true, tree: [branch] });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest() });
  assert.deepEqual(result.window, { title: 'FAKE TITLE' }); assert.equal(result.app.id, EDGE.id);
  assert.equal(native.attributes.filter(key => key === 'AXRole').length, 6); // focused window depth 0 through depth 5
  assert.ok(!native.calls.reads.some(read => read.element === hidden));
});

test('fake JXA: role traversal has its own wall-clock cap within the 900ms AX budget', () => {
  const native = fakeJXA({ app: EDGE.id, noDocument: true, axStepMs: 30,
    tree: Array.from({ length: 10 }, () => ({ role: 'AXGroup', children: [] })) });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest() });
  assert.deepEqual(result.window, { title: 'FAKE TITLE' }); assert.equal(result.app.id, EDGE.id);
  assert.ok(native.elapsed >= 480 && native.elapsed <= 620, `elapsed ${native.elapsed}`);
  assert.ok(native.attributes.filter(key => key === 'AXRole').length < 11);
  assert.ok(native.calls.timeouts.every(({ seconds }) => seconds > 0 && seconds <= 0.3));
});

test('fake JXA: AX denial, missing window or messaging failure stays app-only; optional URL failures keep only the verified title', () => {
  for (const options of [{ trusted: false }, { noWindow: true }, { createError: true }, { timeoutError: -25204 },
    { axError: key => key === 'AXChildren:count' ? -25204 : 0 }]) {
    const native = fakeJXA({ app: EDGE.id, noDocument: true, ...options });
    const result = native.run({ v: 1, action: 'sample', ...contextRequest() });
    assert.deepEqual(result.app, { ...EDGE, pid: 42 }); assert.equal(result.window, undefined); assert.equal(result.document, undefined);
  }
  // Title already read from the re-verified focused window is real metadata: a capped
  // or failing optional URL lookup must not fabricate a link, but must not erase it either.
  for (const options of [
    { incompleteChildren: true, tree: [{ role: 'AXGroup', children: [] }] },
    { axError: key => key === 'AXURL' ? -25211 : 0 },
  ]) {
    const native = fakeJXA({ app: EDGE.id, noDocument: true, ...options });
    const result = native.run({ v: 1, action: 'sample', ...contextRequest() });
    assert.deepEqual(result.app, { ...EDGE, pid: 42 });
    assert.deepEqual(result.window, { title: 'FAKE TITLE' });
    assert.equal(result.window.url, undefined); assert.equal(result.document, undefined);
  }
});

test('fake JXA: a timed-out AX call cannot leak already copied title/document, and every getter is timeout-bounded', () => {
  const native = fakeJXA({ app: EDGE.id, document: 'https://docs.example.com/work', axStepMs: 300 });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest() });
  assert.equal(result.window, undefined); assert.equal(result.document, undefined); assert.equal(result.app.id, EDGE.id);
  assert.equal(native.elapsed, 900); assert.equal(native.attributes.length, 3);
  assert.equal(native.calls.timeouts.length, native.attributes.length);
  assert.ok(native.calls.timeouts.every(({ seconds }) => seconds > 0 && seconds <= 0.3));
});

test('fake JXA: changed/unverifiable focused window or frontmost identity drops all context but preserves known app identity', () => {
  for (const options of [{ windowRace: true }, { recheckMissing: true }, { equalError: true }, { focusRace: true }, { frontError: 'late' }]) {
    const native = fakeJXA({ app: FEISHU.id, document: 'https://docs.example.com/work', ...options });
    const result = native.run({ v: 1, action: 'sample', ...contextRequest(FEISHU) });
    assert.deepEqual(result.app, { ...FEISHU, pid: 42 }); assert.equal(result.document, undefined); assert.equal(result.window, undefined);
    assert.equal(result.reason, options.frontError ? 'SOURCE_UNAVAILABLE' : 'FOCUS_CHANGED');
  }
  let reads = 0;
  const failedRecheck = fakeJXA({ app: EDGE.id, document: 'https://docs.example.com/work',
    axError: key => key === 'AXFocusedWindow' && ++reads > 1 ? -25204 : 0 });
  assert.equal(failedRecheck.run({ v: 1, action: 'sample', ...contextRequest() }).reason, 'FOCUS_CHANGED');
});

test('fake JXA: NSWorkspace failure is SOURCE_UNAVAILABLE, only a definite unselected app means APP_NOT_ALLOWED', () => {
  for (const options of [{ frontError: true }, { app: '' }, { app: 'not an id' }]) {
    const native = fakeJXA(options), result = native.run({ v: 1, action: 'sample', ...request() });
    assert.equal(result.app, null); assert.equal(result.reason, 'SOURCE_UNAVAILABLE'); assert.deepEqual(native.calls.names, []);
  }
  const definite = fakeJXA({ app: EDGE.id });
  assert.equal(definite.run({ v: 1, action: 'sample', ...request() }).reason, 'APP_NOT_ALLOWED');
  const absent = fakeJXA({ noFront: true });
  assert.equal(absent.run({ v: 1, action: 'sample', ...request() }).reason, 'NO_FRONTMOST_APPLICATION');
});

test('fake JXA: unsafe URL schemes, credentials, local/IP authorities or encoded controls never leave native IPC', () => {
  for (const document of ['http://example.com/', 'javascript:alert(1)', 'file:///private/file.docx', 'https://user:pass@example.com/',
    'https://@example.com/', 'https://localhost/', 'https://sub.localhost/', 'https://host.local./', 'https://127.0.0.1/',
    'https://8.8.8.8/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://example.com/a%0Ab', 'https://example.com/a\nb',
    'https://example.com/\\@private', 'https://%65xample.com/', 'https://intranet/', 'https://example.com/\ud800']) {
    const native = fakeJXA({ app: EDGE.id, document });
    const result = native.run({ v: 1, action: 'sample', ...contextRequest() });
    assert.equal(result.window?.url, undefined, document); assert.equal(result.document, undefined);
    assert.ok(!JSON.stringify(result).includes('user:pass'));
  }
});

test('fake JXA: expanded ordinary local document kinds retain root-first title policy and never enumerate children', () => {
  for (const extension of ['doc', 'docx', 'ppt', 'pptx', 'rtf', 'xlsx', 'xls', 'csv', 'pdf', 'txt', 'md']) {
    const location = `${ROOT}/report.${extension}`, native = fakeJXA({ document: { cfUrl: `file://${location}` } });
    assert.deepEqual(native.run({ v: 1, action: 'sample', ...request() }).document, { path: location, title: 'FAKE TITLE' });
    assert.deepEqual(native.calls.childCounts, []);
  }
});

test('fake JXA: 128-by-128 dynamic request works, malformed consent/actions and excessive bytes cannot trigger native reads', () => {
  const applications = Array.from({ length: 128 }, (_, i) => `org.${String(i).padStart(3, '0')}.${'x'.repeat(247)}`);
  const valid = fakeJXA({ app: applications[0], trusted: false });
  assert.equal(valid.run({ v: 1, action: 'sample', applications, contextApplications: applications, roots: [] }).app.id, applications[0]);
  const invalid = [
    { v: 1, action: 'sample', applications: [EDGE.id], contextApplications: [FEISHU.id], roots: [] },
    { v: 1, action: 'sample', applications: [EDGE.id, EDGE.id], roots: [] },
    { v: 1, action: 'sample', applications: [EDGE.id], contextApplications: [EDGE.id, EDGE.id], roots: [] },
    { v: 1, action: 'sample', applications: [EDGE.id], contextApplications: null, roots: [] },
    { v: 1, action: 'sample', applications: ['com.app\n'], roots: [] },
    { v: 1, action: 'sample', applications: ['com.app\u2028'], roots: [] },
    { v: 1, action: 'sample', applications: ['com.app\u2029'], roots: [] },
    { v: 1, action: 'sample', applications: [EDGE.id], roots: ['/'] },
    { v: 1, action: 'sample', applications: [EDGE.id], roots: [`${ROOT}/../private`] },
    { v: 1, action: 'sample', applications: [EDGE.id], roots: [], code: 'evil()' },
    { v: 1, action: 'applications', roots: [] }, { v: 1, action: 'status', applications: [] },
  ];
  for (const payload of invalid) {
    const native = fakeJXA(); assert.equal(native.run(payload).error, 'SOURCE_UNAVAILABLE');
    assert.equal(native.calls.frontmost, 0); assert.equal(native.calls.discovery, 0); assert.equal(native.calls.axTrust, 0);
  }
  const huge = fakeJXA();
  assert.equal(huge.run({ v: 1, action: 'sample', applications: [WORD.id], roots: Array.from({ length: 32 }, (_, i) => `/${i}${'中'.repeat(6000)}`) }).error, 'SOURCE_UNAVAILABLE');
  assert.equal(huge.calls.frontmost, 0);
  for (const argv of [[], ['{}', '{}'], [7]]) assert.equal(huge.runArgs(argv).error, 'SOURCE_UNAVAILABLE');
});

test('fake JXA: unusually long Unicode sample fields degrade to app-only inside the same 32768-byte budget', () => {
  const location = `${ROOT}/${'中'.repeat(8150)}.docx`;
  const native = fakeJXA({ app: FEISHU.id, name: '名'.repeat(256), document: `file://${location}`, title: '题'.repeat(512), windowUrl: `https://example.com/${'中'.repeat(2000)}` });
  const result = native.run({ v: 1, action: 'sample', ...contextRequest(FEISHU, { roots: [ROOT] }) });
  assert.equal(result.app.id, FEISHU.id); assert.equal(result.window, undefined); assert.equal(result.document, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
});

test('fake JXA: NSArray-shaped discovery and bounded AX slices work without deep-unwrapping native arrays', () => {
  const items = [runningApp(EDGE.id, EDGE.name), { bundleIdentifier: FEISHU.id, activationPolicy: 1,
    get localizedName() { throw new Error('temporarily unavailable'); } }];
  const native = fakeJXA({ running: { count: items.length, objectAtIndex: index => items[index] } });
  assert.deepEqual(native.run({ v: 1, action: 'applications' }), discovery([{ ...FEISHU, name: FEISHU.id, foreground: false }, EDGE]));
  const web = fakeJXA({ app: FEISHU.id, noDocument: true, nativeArrays: true,
    tree: [{ role: 'AXGroup', children: [{ role: 'AXWebArea', url: 'https://docs.example.com/work' }] }] });
  assert.equal(web.run({ v: 1, action: 'sample', ...contextRequest(FEISHU) }).window.url, 'https://docs.example.com/work');
});

test('fake JXA: title length caps do not split emoji or leave trailing whitespace at the cutoff', () => {
  for (const [title, expected] of [['x'.repeat(511) + '🐦', 'x'.repeat(511)], ['x'.repeat(510) + ' 🐦', 'x'.repeat(510)]]) {
    const native = fakeJXA({ app: EDGE.id, document: 'https://docs.example.com/work', title });
    const value = native.run({ v: 1, action: 'sample', ...contextRequest() }).window.title;
    assert.equal(value, expected); assert.ok(value.isWellFormed()); assert.ok(value.length <= 512);
  }
});

test('static JXA remains a fixed passive Cocoa/AX metadata program with no content, actions, automation or prompting APIs', () => {
  assert.ok(!/AXValue|AXSelectedText|AXUIElementCopyParameterizedAttributeValue|AXUIElementPerformAction|AXUIElementSetAttributeValue/u.test(jxaSource));
  assert.ok(!/doShellScript|System Events|AXIsProcessTrustedWithOptions\s*\(|requestAccess|pasteboard|CGWindowListCreateImage|ScreenCapture/iu.test(jxaSource));
});
