import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createVoiceRuntime, voiceRuntimeEnvironment } from '../lib/voice-runtime.js';
import { encodeMessage, MAX_LINE_BYTES } from '../native/protocol.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const INITIAL = Object.freeze({ v: 1, type: 'init', shortcut: 'CommandOrControl+Shift+Space', title: '工作资料语音' });
const MANIFEST = Object.freeze({ executable: '/owned-fixture/Voice Helper.app/Contents/MacOS/WorkfilesVoice', bundleRoot: '/owned-fixture/bundle', electronVersion: '42.0.0' });
const READY = Object.freeze({ v: 1, type: 'ready', shortcut: INITIAL.shortcut, registered: true, platform: 'darwin', electronVersion: MANIFEST.electronVersion });
function deferred(fallback = MANIFEST) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject, release: () => resolve(fallback) };
}

// Fully in-memory managed-child double. No process is spawned and no native app is opened.
function fakeChild(options = {}) {
  const completion = deferred();
  const stdout = new PassThrough();
  const writes = [], messages = [], blocked = [];
  let finished = false, released = false, child;
  const stdin = new Writable({
    write(chunk, encoding, callback) {
      const line = chunk.toString('utf8');
      writes.push(line);
      try { messages.push(JSON.parse(line)); } catch (error) { callback(error); return; }
      if (options.autoReady !== false && messages.at(-1).type === 'init') {
        stdout.write(encodeMessage({ ...READY, ...options.ready }));
      }
      if (!released && options.blockAfter !== undefined && writes.length > options.blockAfter) blocked.push(callback);
      else callback();
    },
    final(callback) {
      child.stdinEnds++;
      callback();
      if (options.autoExitOnEnd !== false) queueMicrotask(() => child.exit(0));
    },
  });
  child = {
    stdin: options.noStdin ? undefined : stdin,
    stdout: options.noStdout ? undefined : stdout,
    done: completion.promise,
    writes, messages, stdinEnds: 0, terminations: 0, waits: 0,
    terminate() {
      this.terminations++;
      if (options.autoExitOnTerminate !== false) queueMicrotask(() => this.exit(null, 'SIGTERM'));
    },
    waitForExit() { this.waits++; return completion.promise.then(() => true); },
    emit(message) { stdout.write(encodeMessage(message)); },
    raw(bytes) { stdout.write(bytes); },
    end(bytes) { stdout.end(bytes); },
    unblock() { released = true; for (const callback of blocked.splice(0)) callback(); },
    exit(exitCode = 0, signal = null) {
      if (finished) return;
      finished = true;
      stdout.end();
      completion.resolve({ exitCode, signal });
    },
    destroyStreams() { stdin.destroy(); stdout.destroy(); },
  };
  // Missing-pipe test doubles still own the otherwise unreachable stream objects.
  return child;
}

function harness(t, options = {}) {
  const children = [], spawns = [], messages = [], exits = [], starts = [], controls = [], held = [], manifestRoots = [];
  const runtime = createVoiceRuntime({
    subprocess: { spawn(value) {
      spawns.push(value);
      if (options.spawnError && spawns.length === 1) throw options.spawnError;
      const child = fakeChild(options.child); children.push(child);
      // The public managed subprocess seam must honor its abort signal.
      const abort = () => child.terminate();
      value.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => value.signal?.removeEventListener('abort', abort);
      child.done.then(cleanup, cleanup);
      return child;
    } },
    bundleRoot: '/owned-fixture/bundle', signal: options.signal,
    loadManifest: async root => { manifestRoots.push(root); return options.loadManifest ? options.loadManifest(root) : MANIFEST; },
    startupMs: options.startupMs || 1000, shutdownMs: options.shutdownMs || 1000,
  });
  const h = {
    runtime, children, spawns, messages, exits, manifestRoots,
    hold(fallback) { const item = deferred(fallback); held.push(item); return item; },
    start({ initial = INITIAL, onMessage } = {}) {
      const promise = runtime.start({ initial, onMessage(message) { messages.push(message); onMessage?.(message); }, onExit(error) { exits.push(error); } });
      starts.push(promise);
      promise.then(control => { controls.push(control); }, () => {});
      promise.catch(() => {});
      return promise;
    },
    get child() { return children.at(-1); },
    async cleanup() {
      for (const item of held) item.release();
      await turn();
      for (const child of children) { child.unblock(); child.exit(0); }
      await Promise.allSettled(starts);
      await Promise.allSettled(controls.map(control => control.dispose()));
      for (const child of children) child.destroyStreams();
    },
  };
  t.after(() => h.cleanup());
  return h;
}

test('runtime environment tombstones ambient injection, display, proxy and credential variables', () => {
  const source = {
    HOME: '/fixture/home', TMPDIR: '/fixture/tmp', LANG: 'zh_CN.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8',
    PATH: '/attacker/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require /attacker.cjs',
    NODE_PATH: '/attacker/modules', DYLD_INSERT_LIBRARIES: '/attacker.dylib', DYLD_LIBRARY_PATH: '/attacker',
    LD_PRELOAD: '/attacker.so', OPENAI_API_KEY: 'must-not-propagate', ANTHROPIC_API_KEY: 'must-not-propagate',
    SECRET_TOKEN: 'must-not-propagate', HTTP_PROXY: 'http://private-proxy', DISPLAY: ':fixture',
  };
  const env = voiceRuntimeEnvironment(source);
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']) assert.equal(env[key], source[key]);
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  for (const key of Object.keys(source).filter(key => !['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH'].includes(key))) {
    assert.equal(Object.hasOwn(env, key), true, `${key} needs an explicit tombstone in an overlay env`);
    assert.equal(env[key], undefined, `${key} must not reach the helper`);
  }
  assert.equal(source.ELECTRON_RUN_AS_NODE, '1', 'source env is not mutated');
});

test('runtime launches exactly the owned executable argv with managed private stdio and bounded stderr', async t => {
  const h = harness(t);
  const control = await h.start();
  assert.deepEqual(h.manifestRoots, ['/owned-fixture/bundle']);
  assert.equal(h.spawns.length, 1);
  const spawn = h.spawns[0];
  assert.deepEqual(spawn.argv, [MANIFEST.executable]);
  assert.equal(spawn.cwd, MANIFEST.bundleRoot);
  assert.deepEqual(spawn.stdio, { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } });
  assert.equal(spawn.graceMs, 2000);
  assert.ok(spawn.signal instanceof AbortSignal);
  assert.equal(spawn.signal.aborted, false);
  assert.equal(Object.hasOwn(spawn, 'shell'), false);
  assert.equal(Object.hasOwn(spawn, 'command'), false);
  assert.equal(spawn.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(spawn.env.NODE_OPTIONS, undefined);
  assert.deepEqual(h.child.messages, [INITIAL]);
  assert.equal(h.child.writes[0], JSON.stringify(INITIAL) + '\n');
  assert.deepEqual(h.messages, [READY]);
  assert.equal(Object.isFrozen(h.messages[0]), true);
  assert.equal(control.send({ v: 1, type: 'show', activationId: 'fixture', capture: false }), true);
  await turn();
  assert.deepEqual(h.child.messages.at(-1), { v: 1, type: 'show', activationId: 'fixture', capture: false });
});

test('native registration failure is surfaced as a fact, never silently treated as a successful hotkey', async t => {
  const h = harness(t, { child: { ready: { registered: false } } });
  await h.start();
  assert.equal(h.messages[0].registered, false);
  assert.equal(h.child.terminations, 0, 'panel may remain usable without the occupied accelerator');
});

test('start rejects an already running instance without creating another subprocess', async t => {
  const h = harness(t);
  await h.start();
  await assert.rejects(h.start(), /已经启动/);
  assert.equal(h.children.length, 1);
});

test('concurrent starts during manifest loading cannot create two owned helper processes', async t => {
  let manifest;
  const h = harness(t, { loadManifest: () => manifest.promise });
  manifest = h.hold(MANIFEST);
  const first = h.start(), second = h.start();
  manifest.resolve(MANIFEST);
  const results = await Promise.allSettled([first, second]);
  assert.equal(h.children.length, 1, 'reserve startup ownership before the first await');
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  assert.ok(fulfilled.length >= 1);
  if (fulfilled.length === 2) assert.equal(fulfilled[0].value, fulfilled[1].value);
});

test('manifest validation failure releases startup ownership so a corrected retry can run', async t => {
  let loads = 0;
  const h = harness(t, { loadManifest: async () => {
    if (++loads === 1) throw new Error('fixture artifact validation failed');
    return MANIFEST;
  } });
  await assert.rejects(h.start(), /artifact validation failed/);
  assert.equal(h.children.length, 0);
  const control = await h.start();
  assert.equal(h.children.length, 1);
  await control.dispose();
});

test('synchronous managed spawn failure does not poison a later start', async t => {
  const h = harness(t, { spawnError: new Error('fixture spawn failed') });
  await assert.rejects(h.start(), /fixture spawn failed/);
  assert.equal(h.children.length, 0);
  const control = await h.start();
  assert.equal(h.children.length, 1);
  await control.dispose();
});

test('an aborted feature never loads a manifest or spawns a helper', async t => {
  const abort = new AbortController(); abort.abort(new Error('feature stopped'));
  const h = harness(t, { signal: abort.signal });
  await assert.rejects(h.start(), /feature stopped/);
  assert.equal(h.manifestRoots.length, 0);
  assert.equal(h.children.length, 0);
});

test('abort during manifest loading prevents any later spawn', async t => {
  const abort = new AbortController();
  let manifest;
  const h = harness(t, { signal: abort.signal, loadManifest: () => manifest.promise });
  manifest = h.hold(MANIFEST);
  const start = h.start();
  await turn();
  abort.abort(new Error('feature stopped during manifest'));
  manifest.resolve(MANIFEST);
  await assert.rejects(start, /feature stopped during manifest/);
  assert.equal(h.children.length, 0);
});

test('feature abort reaches the managed range and prevents all later Host sends', async t => {
  const abort = new AbortController();
  const h = harness(t, { signal: abort.signal });
  const control = await h.start();
  abort.abort(new Error('feature disabled'));
  assert.equal(h.spawns[0].signal.aborted, true);
  await turn();
  assert.ok(h.child.terminations >= 1, 'managed provider observes the combined abort signal');
  assert.equal(control.send({ v: 1, type: 'show', activationId: 'late', capture: true }), false);
});

test('runtime version mismatch fails startup closed and terminates the child', async t => {
  const h = harness(t, { child: { ready: { electronVersion: '41.0.0' } } });
  await assert.rejects(h.start(), /运行时版本不一致/);
  assert.ok(h.child.terminations >= 1);
  assert.equal(h.exits.length, 1);
  assert.equal(h.messages.length, 0);
});

test('a child exiting before ready rejects startup rather than returning a usable control', async t => {
  const h = harness(t, { child: { autoReady: false } });
  const start = h.start();
  await turn(); h.child.exit(1);
  await assert.rejects(start, /退出|未能运行/);
  assert.equal(h.exits.length, 1);
});

test('missing private pipes are rejected and the child is reaped', async t => {
  for (const child of [{ noStdin: true }, { noStdout: true }]) {
    const h = harness(t, { child });
    await assert.rejects(h.start(), /受控连接/);
    assert.ok(h.child.terminations >= 1);
    assert.ok(h.child.waits >= 1);
  }
});

test('startup timeout terminates and reaps a helper that never sends ready', async t => {
  const h = harness(t, { startupMs: 10, child: { autoReady: false } });
  await Promise.all([assert.rejects(h.start(), /启动超时/), delay(40)]);
  assert.ok(h.child.terminations >= 1);
  assert.ok(h.child.waits >= 1);
});

test('bounded framing handles split UTF-8 and multiple complete helper messages', async t => {
  const h = harness(t);
  await h.start();
  const one = { v: 1, type: 'notice', code: 'fixture', message: '你好，预算文档' };
  const two = { v: 1, type: 'closed', activationId: 'fixture' };
  const bytes = Buffer.from(encodeMessage(one) + encodeMessage(two));
  const cut = bytes.indexOf(Buffer.from('你')) + 1;
  h.child.raw(bytes.subarray(0, cut));
  assert.equal(h.messages.length, 1, 'partial bytes never become a business message');
  h.child.raw(bytes.subarray(cut));
  assert.deepEqual(h.messages.slice(1), [one, two]);
  assert.equal(h.exits.length, 0);
});

for (const [name, bytes] of [
  ['malformed JSON', Buffer.from('{"v":1,\n')],
  ['unknown fields', Buffer.from(JSON.stringify({ ...READY, secret: 'not-allowed' }) + '\n')],
  ['unsupported version', Buffer.from('{"v":2,"type":"closed"}\n')],
  ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
  ['unbounded line without newline', Buffer.alloc(MAX_LINE_BYTES + 1, 65)],
]) {
  test(`strict helper IPC fails closed for ${name}`, async t => {
    const h = harness(t);
    const control = await h.start();
    h.child.raw(bytes);
    // Terminal framing errors cannot admit subsequent valid data.
    h.child.raw(Buffer.from(encodeMessage({ v: 1, type: 'closed', activationId: 'should-not-arrive' })));
    await turn();
    assert.equal(h.messages.length, 1);
    assert.equal(h.exits.length, 1);
    assert.ok(h.child.terminations >= 1);
    assert.equal(control.send({ v: 1, type: 'hide' }), false);
    assert.ok(h.exits[0].message.length < 1000, 'do not echo malformed payloads');
  });
}

test('a truncated final line on EOF is a terminal protocol failure', async t => {
  const h = harness(t);
  await h.start();
  h.child.end(Buffer.from('{"v":1,"type":"closed"}'));
  await turn();
  assert.equal(h.exits.length, 1);
  assert.equal(h.exits[0].code, 'TRUNCATED_LINE');
  assert.ok(h.child.terminations >= 1);
});

test('protocol failure seals outgoing admission immediately, not only after eventual OS exit', async t => {
  const h = harness(t);
  const control = await h.start();
  h.child.raw(Buffer.from('{"v":1,"type":"unknown"}\n'));
  assert.equal(control.send({ v: 1, type: 'show', activationId: 'after-failure', capture: true }), false);
  await turn();
  assert.ok(!h.child.messages.some(message => message.activationId === 'after-failure'));
});

test('outgoing Host states are strictly validated before any write', async t => {
  const h = harness(t);
  const control = await h.start();
  assert.equal(control.send({ v: 1, type: 'state', activationId: 'fixture', phase: 'preparing', listen: true }), false);
  await turn();
  assert.deepEqual(h.child.messages, [INITIAL]);
  assert.equal(h.exits.length, 1);
  assert.ok(h.child.terminations >= 1);
});

test('consumer callback exceptions fail closed instead of escaping a stream listener', async t => {
  const h = harness(t);
  let received = 0;
  const control = await h.start({ onMessage(message) { if (message.type === 'notice') { received++; throw new Error('fixture handler failure'); } } });
  assert.doesNotThrow(() => h.child.emit({ v: 1, type: 'notice', code: 'fixture', message: 'safe diagnostic' }));
  await turn();
  assert.equal(received, 1);
  assert.equal(h.exits.length, 1);
  assert.equal(h.exits[0].message, 'fixture handler failure');
  assert.equal(control.send({ v: 1, type: 'hide' }), false);
});

for (const pipe of ['stdin', 'stdout']) {
  test(`private ${pipe} stream error terminates the helper and emits one bounded failure`, async t => {
    const h = harness(t);
    const control = await h.start();
    assert.doesNotThrow(() => h.child[pipe].emit('error', new Error(`fixture ${pipe} failure`)));
    await turn();
    assert.equal(h.exits.length, 1);
    assert.equal(h.exits[0].message, `fixture ${pipe} failure`);
    assert.ok(h.child.terminations >= 1);
    assert.equal(control.send({ v: 1, type: 'hide' }), false);
  });
}

test('unexpected child exit is reported once and future sends are rejected', async t => {
  const h = harness(t);
  const control = await h.start();
  h.child.exit(7);
  await turn();
  assert.equal(h.exits.length, 1);
  assert.match(h.exits[0].message, /7/);
  assert.equal(control.send({ v: 1, type: 'hide' }), false);
});

test('graceful disposal writes shutdown, closes stdin, reaps exactly once and suppresses exit alarms', async t => {
  const h = harness(t);
  const control = await h.start();
  await Promise.all([control.dispose(), control.dispose()]);
  assert.equal(h.child.messages.filter(message => message.type === 'shutdown').length, 1);
  assert.equal(h.child.stdinEnds, 1);
  assert.equal(h.child.terminations, 0);
  assert.equal(h.child.waits, 1);
  assert.equal(h.spawns[0].signal.aborted, true);
  assert.equal(h.exits.length, 0);
  assert.equal(h.child.stdout.listenerCount('data'), 0);
  assert.equal(control.send({ v: 1, type: 'hide' }), false);
});

test('shutdown grace expiry terminates a helper that ignores graceful EOF', async t => {
  const h = harness(t, { shutdownMs: 10, child: { autoExitOnEnd: false } });
  const control = await h.start();
  await Promise.all([control.dispose(), delay(40)]);
  assert.ok(h.child.terminations >= 1);
  assert.ok(h.child.waits >= 1);
  assert.equal(h.exits.length, 0, 'intentional shutdown is not a spontaneous native failure');
});

test('shutdown is bounded even if an earlier stdin write callback never drains', async t => {
  const h = harness(t, { shutdownMs: 10, child: { blockAfter: 1, autoExitOnEnd: false } });
  const control = await h.start();
  control.send({ v: 1, type: 'show', activationId: 'blocked', capture: false });
  await turn();
  let completed = false;
  const closing = control.dispose().then(() => { completed = true; });
  closing.catch(() => {});
  await delay(40);
  assert.ok(h.child.terminations >= 1, 'shutdown deadline must include the writeTail drain');
  assert.equal(completed, true);
  await closing;
});
