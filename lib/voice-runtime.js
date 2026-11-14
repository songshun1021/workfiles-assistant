import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createLineDecoder, parseHelperMessage, parseHostMessage, encodeMessage, MAX_LINE_BYTES } from '../native/protocol.mjs';

const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
async function fileHash(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
function raceAbort(pending, signal) {
  if (signal.aborted) { void Promise.resolve(pending).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** subprocess env overlays a scrubbed parent base: tombstone ordinary ambient extras too. */
export function voiceRuntimeEnvironment(source = process.env) {
  const result = {};
  for (const key of Object.keys(source)) if (!key.startsWith('DSH_')) result[key] = undefined;
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) if (typeof source[key] === 'string') result[key] = source[key];
  result.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  result.ELECTRON_RUN_AS_NODE = undefined; result.NODE_OPTIONS = undefined;
  return result;
}

/** Private build record, not a configurable/Agent-supplied command. Cache location explicitly approved. */
export async function loadVoiceHelper(bundleRoot, { sourceExecutable = process.env.DSH_NODE_EXECUTABLE || process.execPath, electronVersion = process.versions.electron } = {}) {
  const root = await fs.realpath(bundleRoot), nativeRoot = path.join(root, '.native');
  const manifestPath = path.join(nativeRoot, 'helper.json'), stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 || await fs.realpath(nativeRoot) !== nativeRoot) throw new Error('桌面语音组件的构建记录无效，请重新准备组件。');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.v !== 1 || manifest.owner !== 'workfiles-voice-native-v1' || !/^[0-9a-f]{24}$/u.test(manifest.buildId) || typeof manifest.executableRelative !== 'string' || path.isAbsolute(manifest.executableRelative) || !digest(manifest.executableHash) || !digest(manifest.sourceExecutableHash) || !digest(manifest.sourceRuntimeHash)) throw new Error('桌面语音组件的构建记录不匹配。');
  const approvedCache = path.join(os.homedir(), 'Library/Caches/DeepSeekHarness/WorkfilesVoice');
  const artifactRoot = manifest.artifactRoot === undefined ? nativeRoot : path.resolve(manifest.artifactRoot);
  if (![nativeRoot, approvedCache].includes(artifactRoot) || await fs.realpath(artifactRoot) !== artifactRoot) throw new Error('桌面组件不在已批准的位置。');
  const relativeBase = manifest.executableRelativeBase === 'artifactRoot' ? artifactRoot : root;
  const executable = path.resolve(relativeBase, manifest.executableRelative);
  const buildRoot = path.join(artifactRoot, `${manifest.buildId}.nosync`);
  const legacyBuildRoot = path.join(nativeRoot, manifest.buildId);
  const executableStat = await fs.lstat(executable);
  if ((!inside(buildRoot, executable) && !(artifactRoot === nativeRoot && inside(legacyBuildRoot, executable))) || await fs.realpath(executable) !== executable || !executableStat.isFile() || !(executableStat.mode & 0o111)) throw new Error('桌面语音组件不是受控的本地程序。');
  const currentSource = await fs.realpath(sourceExecutable), recordedSource = await fs.realpath(manifest.sourceExecutable);
  const sourceApp = path.resolve(currentSource, '../../..'), framework = await fs.realpath(manifest.sourceFrameworkBinary);
  if (!sourceApp.endsWith('.app') || currentSource !== recordedSource || !inside(path.join(sourceApp, 'Contents/Frameworks'), framework) || electronVersion && manifest.electronVersion !== electronVersion) throw new Error('Harness 版本已改变，需要重新准备桌面语音组件。');
  if (await fileHash(executable) !== manifest.executableHash || await fileHash(currentSource) !== manifest.sourceExecutableHash || await fileHash(framework) !== manifest.sourceRuntimeHash) throw new Error('Harness 或桌面语音组件已更新，需要重新构建后再使用。');
  const appRoot = path.resolve(executable, '../../..');
  if (manifest.runtimeMode === 'copied-frameworks-owned-launchers') {
    const copiedFramework = await fs.realpath(path.join(appRoot, path.relative(sourceApp, framework)));
    if (!inside(appRoot, copiedFramework) || await fileHash(copiedFramework) !== manifest.sourceRuntimeHash) throw new Error('桌面组件的本地运行时副本已改变。');
  }
  const resourceNames = ['native/main.mjs', 'native/preload.cjs', 'native/protocol.mjs', 'native/security.mjs', 'native/controller.mjs', 'native/LICENSE.Electron', 'voice-ui/index.html', 'voice-ui/panel.js', 'voice-ui/panel.css', 'voice-ui/audio.js', 'voice-ui/view-state.js'];
  if (!manifest.resourceHashes || resourceNames.some(name => !digest(manifest.resourceHashes[name]))) throw new Error('桌面组件资源记录不完整。');
  for (const name of resourceNames) {
    const expected = manifest.resourceHashes[name];
    if (await fileHash(path.join(root, name)) !== expected || await fileHash(path.join(appRoot, 'Contents/Resources/app', name)) !== expected) throw new Error('语音界面源码已改变，请重新构建桌面组件。');
  }
  return { ...manifest, executable, bundleRoot: root };
}

/** Private managed stdio, bounded framing, sealed failures and managed-range teardown. */
export function createVoiceRuntime({ subprocess, bundleRoot, signal, loadManifest = loadVoiceHelper, startupMs = 10000, shutdownMs = 2500 }) {
  let instance, previousCleanup = Promise.resolve();
  return {
    async start({ initial, onMessage, onExit = () => {} }) {
      signal?.throwIfAborted();
      if (instance) throw new Error('桌面语音组件已经启动。');
      const current = {}; instance = current; // Reserve before the first await: no concurrent double spawn.
      let manifest, child;
      const lifetime = new AbortController();
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      try {
        await previousCleanup;
        manifest = await loadManifest(bundleRoot); combined.throwIfAborted();
        child = subprocess.spawn({ argv: [manifest.executable], cwd: manifest.bundleRoot || bundleRoot, env: voiceRuntimeEnvironment(), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } }, graceMs: 2000, signal: combined });
      } catch (error) { if (instance === current) instance = undefined; throw error; }
      current.child = child;
      if (!child.stdin || !child.stdout) {
        child.terminate(); await child.waitForExit(AbortSignal.timeout(5000));
        if (instance === current) instance = undefined;
        throw new Error('无法建立桌面语音组件的受控连接。');
      }
      let closing = false, sealed = false, exited = false, notified = false, ready = false, queuedBytes = 0, writeTail = Promise.resolve(), timer, stopPromise, cleanup, shutdownDeadline;
      let resolveReady, rejectReady;
      const whenReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      function cleanRange(reason, force = true) {
        if (cleanup) return cleanup;
        if (force) { child.terminate(); lifetime.abort(reason); }
        cleanup = Promise.resolve().then(async () => {
          let quiescent = await child.waitForExit(force ? AbortSignal.timeout(5000) : shutdownDeadline || AbortSignal.timeout(shutdownMs));
          if (quiescent === false && !force) {
            child.terminate(); lifetime.abort(reason);
            quiescent = await child.waitForExit(AbortSignal.timeout(5000));
          }
          if (quiescent === false) throw new Error('桌面语音组件尚未完全退出，请重启 Harness 后再试。');
          lifetime.abort(reason);
        });
        previousCleanup = cleanup; cleanup.catch(() => {});
        return cleanup;
      }
      const notify = error => {
        if (notified) return;
        notified = true; clearTimeout(timer);
        if (instance === current) instance = undefined;
        if (!ready) rejectReady(error || new Error('桌面语音组件在就绪前退出。'));
        if (!closing) onExit(error);
      };
      const fail = error => {
        if (sealed || exited) return;
        sealed = true; // Revoke authority now, not after OS exit.
        cleanRange(error); notify(error);
      };
      function send(message) {
        if (sealed || exited || closing && message.type !== 'shutdown') return false;
        let line;
        try { line = encodeMessage(parseHostMessage(message)); }
        catch (error) { fail(error); return false; }
        const bytes = Buffer.byteLength(line);
        if (queuedBytes + bytes > 4 * MAX_LINE_BYTES) { fail(new Error('桌面语音组件没有及时接收状态，已停止。')); return false; }
        queuedBytes += bytes;
        writeTail = writeTail.then(() => new Promise((resolve, reject) => {
          if (sealed || exited || child.stdin.destroyed) { reject(new Error('桌面语音连接已关闭。')); return; }
          child.stdin.write(line, error => error ? reject(error) : resolve());
        })).finally(() => { queuedBytes -= bytes; });
        writeTail.catch(fail); return true;
      }
      const decoder = createLineDecoder({ parse: parseHelperMessage, onMessage(message) {
        if (sealed || exited) return;
        if (message.type === 'ready') {
          if (message.electronVersion !== manifest.electronVersion) { fail(new Error('桌面语音组件的运行时版本不一致。')); return; }
          ready = true; clearTimeout(timer); resolveReady();
        }
        try { onMessage(message); } catch (error) { fail(error); }
      }, onError: fail });
      const data = chunk => decoder.push(chunk);
      child.stdout.on('data', data); child.stdout.on('end', () => decoder.end());
      child.stdout.on('error', fail); child.stdin.on('error', fail);
      const outcome = child.done.then(result => {
        exited = true; sealed = true;
        const error = !closing ? new Error(result.exitCode === 0 && !result.signal ? '桌面语音组件已退出。' : `桌面语音组件未能运行（${result.exitCode ?? result.signal ?? '未知原因'}）。`) : undefined;
        // done is only the main process. Its renderers/helpers must be reaped too.
        cleanRange(error || new Error('桌面组件已结束。'), !closing); notify(error); return result;
      }, error => { exited = true; sealed = true; cleanRange(error); notify(error); throw error; });
      outcome.catch(() => {});
      timer = setTimeout(() => fail(new Error('桌面语音组件启动超时，请重试。')), startupMs); timer.unref?.();
      send(initial);
      const control = {
        send,
        dispose() {
          if (stopPromise) return stopPromise;
          stopPromise = (async () => {
            const deadline = AbortSignal.timeout(shutdownMs); shutdownDeadline = deadline; closing = true;
            if (!sealed && !exited) {
              send({ v: 1, type: 'shutdown' });
              // The grace starts before flushing. A stuck write cannot block termination.
              const flushed = await raceAbort(writeTail, deadline).then(() => true, () => false);
              if (flushed && !child.stdin.destroyed) child.stdin.end();
              await raceAbort(outcome, deadline).catch(() => {});
            }
            sealed = true; await cleanRange(new Error('桌面语音入口已停用。'), !exited);
            await raceAbort(outcome, AbortSignal.timeout(5000)).catch(() => {});
            child.stdout.removeListener('data', data); clearTimeout(timer);
            if (instance === current) instance = undefined;
          })();
          return stopPromise;
        },
      };
      try { await whenReady; return control; }
      catch (error) { closing = true; sealed = true; await cleanRange(error).catch(() => {}); clearTimeout(timer); throw error; }
    },
  };
}
