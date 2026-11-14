import fs from 'node:fs/promises';
import path from 'node:path';
import { isApplicationId, MAX_ACTIVITY_APPLICATIONS, normalizeWindowHint } from './activity-policy.js';

export const MAC_ACTIVITY_APPLICATIONS = Object.freeze([
  Object.freeze({ id: 'com.microsoft.Word', name: 'Microsoft Word' }),
  Object.freeze({ id: 'com.microsoft.Powerpoint', name: 'Microsoft PowerPoint' }),
  Object.freeze({ id: 'com.kingsoft.wpsoffice.mac', name: 'WPS Office' }),
]);
const APPLICATIONS = new Map(MAC_ACTIVITY_APPLICATIONS.map(app => [app.id, app]));
const SOURCE = 'jxa-applicationservices';
// The request accommodates 128 selected + 128 context IDs (each <=255); output stays private and capped.
const MAX_REQUEST_BYTES = 131072, MAX_OUTPUT_BYTES = 32768, MAX_STDERR_BYTES = 4096;
// Metadata only, matching the workfile engine's FILE_KINDS (never executable/package contents).
const EXTENSIONS = new Set(['.doc', '.docx', '.ppt', '.pptx', '.rtf', '.xlsx', '.xls', '.csv', '.pdf', '.txt', '.md']);
const REASONS = new Set(['accessibility_required_for_documents', 'AX_PERMISSION_REQUIRED', 'NO_FRONTMOST_APPLICATION', 'APP_NOT_ALLOWED', 'NO_ALLOWED_ROOTS', 'INVALID_SCOPE',
  'DOCUMENT_NOT_AVAILABLE', 'DOCUMENT_OUT_OF_SCOPE', 'FOCUS_CHANGED', 'NO_SELECTED_APPLICATIONS', 'SOURCE_UNAVAILABLE']);
// Unicode mode rejects lone surrogates, not paired astral characters (e.g. emoji in app names).
const safeString = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function failure(code, message = '本机只读上下文服务暂不可用。') { const error = new Error(message); error.code = code; return error; }
function abortReason(signal) { return signal.reason ?? new DOMException('操作已取消。', 'AbortError'); }
function raceAbort(pending, signal) {
  if (signal.aborted) { void Promise.resolve(pending).catch(() => {}); return Promise.reject(abortReason(signal)); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortReason(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function environment(source) {
  const result = {};
  for (const name of Object.keys(source)) result[name] = undefined;
  for (const name of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) if (typeof source[name] === 'string') result[name] = source[name];
  result.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  for (const name of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'OSA_COMPONENT_PATH', 'BASH_ENV', 'ENV']) result[name] = undefined;
  return result;
}
function validPath(value) { return safeString(value, 8192) && path.isAbsolute(value) && path.normalize(value) === value; }
function validateApplications(value) {
  if (!Array.isArray(value) || value.length > MAX_ACTIVITY_APPLICATIONS || new Set(value).size !== value.length || [...value].some(id => !isApplicationId(id))) {
    throw failure('INVALID_APPLICATIONS', '请选择不重复的有效软件标识，最多 128 项。');
  }
  return [...value];
}
function validateContextApplications(value, applications) {
  const context = validateApplications(value);
  if (context.some(id => !applications.includes(id))) throw failure('INVALID_CONTEXT_APPLICATIONS', '窗口线索授权必须属于已选择的软件。');
  return context;
}
function validateRoots(value) {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length || [...value].some(root => !validPath(root) || root === path.parse(root).root)) {
    throw failure('INVALID_SCOPE', '资料范围必须是明确选择的规范文件夹。');
  }
  return [...value];
}
function validateReason(value) { if (value !== undefined && !REASONS.has(value)) throw failure('INVALID_SOURCE_RESPONSE'); }
function parseJSON(bytes) {
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!object(value)) throw new Error(); return value; }
  catch { throw failure('INVALID_SOURCE_RESPONSE'); }
}

/**
 * A passive reader, not a collector: constructing/status() never observes windows or running app names.
 * discoverApplications() is ONLY for an explicit Human UI refresh, never status/startup/model calls.
 * sample() must only be called by the Human-enabled ledger or an explicitly authorized one-shot request;
 * selected app identity is independent of separate contextApplications title/HTTPS-metadata consent.
 * The only executable is macOS osascript, the only program is this bundle's static JXA file.
 * fileSystem/platform/now/timeoutMs/cleanupMs/env are host-owned test seams, never model input.
 */
export function createMacActivitySource({ subprocess, signal, bundleRoot, fileSystem = fs, platform = process.platform,
  now = () => new Date().toISOString(), timeoutMs = 2500, cleanupMs = 1500, env = process.env } = {}) {
  if (!subprocess || typeof subprocess.spawn !== 'function' || !safeString(bundleRoot, 8192) || !path.isAbsolute(bundleRoot)) throw failure('INVALID_SOURCE_OPTIONS');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 5000) throw failure('INVALID_SOURCE_OPTIONS');
  const lifetime = new AbortController(), operations = new Set();
  let disposed = false, disposal, poisoned;
  const parentAbort = () => lifetime.abort(abortReason(signal));
  if (signal?.aborted) parentAbort(); else signal?.addEventListener('abort', parentAbort, { once: true });
  function check() { if (disposed) throw failure('SOURCE_DISPOSED'); if (poisoned) throw poisoned; lifetime.signal.throwIfAborted(); }
  async function canonicalRoots(roots, operationSignal) {
    const canonical = [];
    for (const root of roots) {
      operationSignal.throwIfAborted();
      try {
        const real = await raceAbort(fileSystem.realpath(root), operationSignal);
        const stat = await raceAbort(fileSystem.stat(real), operationSignal);
        if (real !== root || !stat.isDirectory()) throw failure('INVALID_SCOPE');
        canonical.push(real);
      } catch (error) { operationSignal.throwIfAborted(); if (error.code === 'INVALID_SCOPE') throw error; throw failure('INVALID_SCOPE'); }
    }
    return canonical;
  }
  async function program(operationSignal) {
    try {
      const root = await raceAbort(fileSystem.realpath(bundleRoot), operationSignal);
      const directory = path.join(root, 'native'), script = path.join(directory, 'context-reader.js');
      const [realDirectory, realScript, stat] = await raceAbort(Promise.all([fileSystem.realpath(directory), fileSystem.realpath(script), fileSystem.lstat(script)]), operationSignal);
      if (realDirectory !== directory || realScript !== script || stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 65536) throw failure('INVALID_SOURCE_PROGRAM');
      return { root, script };
    } catch (error) { operationSignal.throwIfAborted(); if (error.code === 'INVALID_SOURCE_PROGRAM') throw error; throw failure('SOURCE_UNAVAILABLE'); }
  }
  async function quiesce(child, force) {
    if (!child) return;
    if (force) { try { child.terminate(); } catch { /* wait must still verify quiescence */ } }
    async function wait() {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(failure('SOURCE_STOP_FAILED')), cleanupMs);
      try { return await raceAbort(child.waitForExit(controller.signal), controller.signal) === true; }
      catch { return false; } finally { clearTimeout(timer); }
    }
    if (await wait()) return;
    try { child.terminate(); } catch { /* cannot count an attempted signal as exit */ }
    if (await wait()) return;
    poisoned = failure('SOURCE_STOP_FAILED', '只读上下文进程尚未完全退出，已停止后续读取。');
    lifetime.abort(poisoned); throw poisoned;
  }
  function execute(action, input = {}, requestSignal, transform) {
    check();
    const own = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, own.signal, ...(requestSignal ? [requestSignal] : [])]);
    combined.throwIfAborted();
    const record = { child: undefined, promise: undefined };
    operations.add(record);
    record.promise = (async () => {
      const timer = setTimeout(() => own.abort(failure('SOURCE_TIMEOUT', '读取上下文超时，已停止本次读取。')), timeoutMs);
      let child, stdout, stderr, data, stderrData, onEnd, onStreamError, normal = false;
      try {
        const roots = action === 'sample' ? await canonicalRoots(input.roots, combined) : undefined;
        const request = { v: 1, action, ...(action === 'sample' ? { applications: input.applications, contextApplications: input.contextApplications, roots } : {}) };
        const argument = JSON.stringify(request);
        if (Buffer.byteLength(argument) > MAX_REQUEST_BYTES) throw failure('INVALID_SCOPE');
        const owned = await program(combined); combined.throwIfAborted();
        child = subprocess.spawn({ argv: ['/usr/bin/osascript', '-l', 'JavaScript', owned.script, argument], cwd: owned.root,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, env: environment(env), graceMs: 250, signal: combined });
        record.child = child;
        void Promise.resolve(child.done).catch(() => {});
        if (!child.stdout || !child.stderr || typeof child.waitForExit !== 'function') throw failure('SOURCE_UNAVAILABLE');
        stdout = child.stdout; stderr = child.stderr;
        let bytes = 0, errorBytes = 0, chunks = [], settled = false;
        const ended = new Promise((resolve, reject) => {
          const fail = error => { if (settled) return; settled = true; reject(error); };
          data = chunk => {
            if (settled || combined.aborted) return;
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.length;
            if (bytes > MAX_OUTPUT_BYTES) { fail(failure('SOURCE_OUTPUT_LIMIT')); own.abort(failure('SOURCE_OUTPUT_LIMIT')); return; }
            chunks.push(value);
          };
          stderrData = chunk => {
            if (combined.aborted) return;
            errorBytes += Buffer.byteLength(chunk);
            // Never retain, print or propagate stderr; it may contain platform details.
            if (errorBytes > MAX_STDERR_BYTES) { fail(failure('SOURCE_OUTPUT_LIMIT')); own.abort(failure('SOURCE_OUTPUT_LIMIT')); }
          };
          onEnd = () => { if (!settled) { settled = true; resolve(); } };
          onStreamError = () => fail(failure('SOURCE_UNAVAILABLE'));
          stdout.on('data', data); stdout.once('end', onEnd); stdout.once('error', onStreamError);
          stderr.on('data', stderrData); stderr.once('error', onStreamError);
          if (stdout.readableEnded) onEnd();
        });
        const outcome = await raceAbort(Promise.all([Promise.resolve(child.done), ended]), combined).then(values => values[0]);
        combined.throwIfAborted();
        if (!outcome || outcome.exitCode !== 0 || outcome.signal !== null) throw failure('SOURCE_UNAVAILABLE');
        const parsed = parseJSON(Buffer.concat(chunks)); chunks = [];
        if (parsed.error !== undefined) throw failure('SOURCE_UNAVAILABLE');
        normal = true;
        return transform ? await raceAbort(transform({ parsed, roots, operationSignal: combined }), combined) : { parsed, roots };
      } catch (error) {
        if (combined.aborted) throw abortReason(combined);
        if (error?.code && typeof error.code === 'string' && /^(?:INVALID_|SOURCE_)/u.test(error.code)) throw error;
        throw failure('SOURCE_UNAVAILABLE');
      } finally {
        // Seal listeners before joining. Late output can never become an accepted sample.
        if (stdout) { if (data) stdout.removeListener('data', data); if (onEnd) stdout.removeListener('end', onEnd); if (onStreamError) stdout.removeListener('error', onStreamError); }
        if (stderr) { if (stderrData) stderr.removeListener('data', stderrData); if (onStreamError) stderr.removeListener('error', onStreamError); }
        const absorb = () => {};
        stdout?.on('error', absorb); stderr?.on('error', absorb);
        try { await quiesce(child, !normal || combined.aborted); }
        finally {
          stdout?.removeListener('error', absorb); stderr?.removeListener('error', absorb);
          clearTimeout(timer); operations.delete(record);
        }
        combined.throwIfAborted();
      }
    })();
    // Callers may be canceled while dispose() separately joins this same promise.
    void record.promise.catch(() => {});
    return record.promise;
  }
  function unsupportedStatus() {
    return { v: 1, platform, source: SOURCE, available: false, accessibilityTrusted: null,
      applications: MAC_ACTIVITY_APPLICATIONS.map(app => ({ ...app, installed: null })), reason: 'UNSUPPORTED_PLATFORM' };
  }
  return {
    async status({ signal: requestSignal } = {}) {
      check(); requestSignal?.throwIfAborted();
      if (platform !== 'darwin') return unsupportedStatus();
      const { parsed } = await execute('status', {}, requestSignal);
      check(); requestSignal?.throwIfAborted();
      if (!keys(parsed, ['v', 'platform', 'source', 'available', 'accessibilityTrusted', 'applications', 'reason']) || parsed.v !== 1 ||
          parsed.platform !== 'darwin' || parsed.source !== SOURCE || parsed.available !== true || typeof parsed.accessibilityTrusted !== 'boolean' ||
          !Array.isArray(parsed.applications) || parsed.applications.length !== APPLICATIONS.size) throw failure('INVALID_SOURCE_RESPONSE');
      validateReason(parsed.reason);
      const ids = new Set();
      const applications = parsed.applications.map(app => {
        if (!keys(app, ['id', 'name', 'installed']) || !APPLICATIONS.has(app.id) || ids.has(app.id) ||
            app.name !== APPLICATIONS.get(app.id).name || !(app.installed === null || typeof app.installed === 'boolean')) throw failure('INVALID_SOURCE_RESPONSE');
        ids.add(app.id); return { ...APPLICATIONS.get(app.id), installed: app.installed };
      });
      return { v: 1, platform: 'darwin', source: SOURCE, available: true, accessibilityTrusted: parsed.accessibilityTrusted, applications,
        ...(!parsed.accessibilityTrusted ? { reason: 'accessibility_required_for_documents' } : {}) };
    },
    async discoverApplications({ signal: requestSignal } = {}) {
      check(); requestSignal?.throwIfAborted();
      if (platform !== 'darwin') throw failure('SOURCE_UNAVAILABLE');
      const { parsed } = await execute('applications', {}, requestSignal);
      check(); requestSignal?.throwIfAborted();
      if (!keys(parsed, ['v', 'platform', 'source', 'applications', 'truncated']) || parsed.v !== 1 || parsed.platform !== 'darwin' ||
          parsed.source !== SOURCE || typeof parsed.truncated !== 'boolean' || !Array.isArray(parsed.applications) ||
          parsed.applications.length > MAX_ACTIVITY_APPLICATIONS) throw failure('INVALID_SOURCE_RESPONSE');
      const ids = new Set();
      const applications = parsed.applications.map(app => {
        if (!keys(app, ['id', 'name', 'installed', 'running', 'foreground']) || !isApplicationId(app.id) || ids.has(app.id) || !safeString(app.name, 256) ||
            app.installed !== true || app.running !== true || typeof app.foreground !== 'boolean') throw failure('INVALID_SOURCE_RESPONSE');
        ids.add(app.id); return { id: app.id, name: app.name, installed: true, running: true, foreground: app.foreground };
      }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return { v: 1, platform: 'darwin', source: SOURCE, applications, truncated: parsed.truncated };
    },
    async sample({ applications, contextApplications = [], roots, signal: requestSignal } = {}) {
      check(); requestSignal?.throwIfAborted();
      const selected = validateApplications(applications), context = validateContextApplications(contextApplications, selected), allowed = validateRoots(roots);
      if (platform !== 'darwin') return { v: 1, observedAt: now(), app: null, reason: 'SOURCE_UNAVAILABLE' };
      if (!selected.length) return { v: 1, observedAt: now(), app: null, reason: 'NO_SELECTED_APPLICATIONS' };
      return execute('sample', { applications: selected, contextApplications: context, roots: allowed }, requestSignal, async ({ parsed, roots: canonical, operationSignal }) => {
        if (!keys(parsed, ['v', 'observedAt', 'app', 'document', 'window', 'reason']) || parsed.v !== 1 || !safeString(parsed.observedAt, 40) ||
            !Number.isFinite(Date.parse(parsed.observedAt)) || !Object.hasOwn(parsed, 'app')) throw failure('INVALID_SOURCE_RESPONSE');
        validateReason(parsed.reason);
        const result = { v: 1, observedAt: now(), app: null, ...(parsed.reason ? { reason: parsed.reason } : {}) };
        if (parsed.app === null) { if (parsed.document !== undefined || parsed.window !== undefined) throw failure('INVALID_SOURCE_RESPONSE'); return result; }
        const app = parsed.app;
        if (!keys(app, ['id', 'name', 'pid']) || !isApplicationId(app.id) || !selected.includes(app.id) || !safeString(app.name, 256) ||
            app.pid !== undefined && (!Number.isSafeInteger(app.pid) || app.pid < 1)) throw failure('INVALID_SOURCE_RESPONSE');
        result.app = { id: app.id, name: app.name, ...(app.pid !== undefined ? { pid: app.pid } : {}) };
        if (parsed.window !== undefined) {
          if (!context.includes(app.id) || !keys(parsed.window, ['title', 'url']) ||
              parsed.window.title !== undefined && (typeof parsed.window.title !== 'string' || parsed.window.title.length > 512) ||
              parsed.window.url !== undefined && (typeof parsed.window.url !== 'string' || parsed.window.url.length > 2048)) throw failure('INVALID_SOURCE_RESPONSE');
          const hint = normalizeWindowHint(parsed.window);
          if (hint) result.window = hint;
        }
        // An uncertain observation is not evidence of an app departure, or current document/window metadata.
        if (parsed.reason === 'FOCUS_CHANGED' || parsed.reason === 'SOURCE_UNAVAILABLE') { delete result.window; return result; }
        if (parsed.document === undefined) return result;
        const document = parsed.document;
        if (!keys(document, ['path', 'title']) || !validPath(document.path) || document.title !== undefined && !safeString(document.title, 512) ||
            !EXTENSIONS.has(path.extname(document.path).toLowerCase())) throw failure('INVALID_SOURCE_RESPONSE');
        // A second Host-side canonical file/root gate, independent of the native program.
        // A revoked/swapped file strips document title too. Separately consented window metadata stays independent.
        if (!canonical.some(root => inside(root, document.path))) { result.reason = 'DOCUMENT_OUT_OF_SCOPE'; return result; }
        try {
          const real = await raceAbort(fileSystem.realpath(document.path), operationSignal);
          const stat = await raceAbort(fileSystem.lstat(real), operationSignal);
          operationSignal.throwIfAborted(); check();
          if (real !== document.path || !stat.isFile() || stat.isSymbolicLink() || !canonical.some(root => inside(root, real))) {
            result.reason = 'DOCUMENT_OUT_OF_SCOPE'; return result;
          }
          for (const root of canonical) if (await raceAbort(fileSystem.realpath(root), operationSignal) !== root) { result.reason = 'DOCUMENT_OUT_OF_SCOPE'; return result; }
          operationSignal.throwIfAborted(); check();
          result.document = { path: real, ...(document.title !== undefined ? { title: document.title } : {}) };
        } catch (error) {
          operationSignal.throwIfAborted(); check();
          result.reason = 'DOCUMENT_NOT_AVAILABLE';
        }
        return result;
      });
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true; signal?.removeEventListener('abort', parentAbort);
      lifetime.abort(new DOMException('只读上下文来源已停用。', 'AbortError'));
      disposal = (async () => {
        await Promise.allSettled([...operations].map(record => record.promise));
        if (poisoned) throw poisoned;
      })();
      return disposal;
    },
  };
}
