import { randomUUID } from 'node:crypto';
import { APPLICATIONS, ACTIVITY_RETENTION_DAYS, ActivityDocumentSchema, ActivityEntrySchema } from './activity-ledger.js';
import { MAX_ACTIVITY_APPLICATIONS, isApplicationId, normalizeApplicationName, normalizeWindowHint } from './activity-policy.js';

const catalog = new Map(APPLICATIONS.map(app => [app.id, app]));
const VOICE_SESSION = /^workfiles-voice-[0-9a-f-]{36}(?![\s\S])/u;
const CURRENT_TTL = 120000;
const publicFailure = () => '暂时不能读取应用线索，原有文件查找仍可使用。';
const STATUS_REASONS = new Set(['UNSUPPORTED_PLATFORM', 'SOURCE_UNAVAILABLE', 'AX_PERMISSION_REQUIRED', 'accessibility_required_for_documents']);
function abortable(pending, signal) {
  if (signal.aborted) { void Promise.resolve(pending).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Owns bounded OS sampling, not a model loop. No timer or OS read before start().
 * Disabled start never samples. Only Human configuration may turn recording on.
 * Current-window reads are separate, explicit-gesture, short-lived capabilities.
 */
export function createActivityController({ ledger, source, getDocumentStatus, validateDocument, signal, now = Date.now, pollMs = 4000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!ledger || !source || typeof getDocumentStatus !== 'function' || typeof validateDocument !== 'function') throw new TypeError('Activity controller dependencies are required.');
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60000) throw new TypeError('Invalid activity sampling interval.');
  const lifetime = new AbortController();
  const tasks = new Set(), cues = new Map(), sessions = new Map();
  let generation = 0, timer, maintenanceTimer, running = false, disposed = false, sampling, samplingAbort, dataEpoch = new AbortController();
  let mutationTail = Promise.resolve(), pendingMutations = 0, sourceFacts, factsAt = 0, discovered = [], lastPollAt = null, lastError = null, disposal;
  const combined = (caller, timeout = 6000) => AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), ...(caller ? [caller] : []), AbortSignal.timeout(timeout)]);
  const track = promise => { const task = Promise.resolve(promise); tasks.add(task); task.catch(() => {}).finally(() => tasks.delete(task)); return task; };
  const allowed = () => {
    const settings = ledger.getSettings();
    return { ...settings, contextApplications: (settings.contextApplications ?? []).filter(id => settings.applications.includes(id)) };
  };
  function clearTimerOnly() { if (timer !== undefined) clearTimer(timer); timer = undefined; }
  function cleanCues() {
    for (const [token, cue] of cues) if (cue.expiresAt <= now() || cue.generation !== generation) releaseCurrent(token);
  }
  function invalidate() {
    generation++; clearTimerOnly();
    const reason = new Error('资料记录设置已改变，请重新查询。');
    samplingAbort?.abort(reason); dataEpoch.abort(reason); dataEpoch = new AbortController();
    for (const token of cues.keys()) releaseCurrent(token);
    sessions.clear();
  }
  function schedule(delay = pollMs) {
    clearTimerOnly();
    if (disposed || !running || pendingMutations || !allowed().enabled || !allowed().applications.length) return;
    timer = setTimer(() => { timer = undefined; void track(poll()).catch(() => {}); }, delay);
    timer?.unref?.();
  }
  function scheduleMaintenance() {
    if (disposed || !running || maintenanceTimer !== undefined) return;
    // Expiry keeps running while recording is paused. This touches only the
    // owned local ledger and approved-file metadata, never NSWorkspace or AX.
    maintenanceTimer = setTimer(() => {
      maintenanceTimer = undefined;
      void track(ledger.purge(combined(undefined, 20000))).catch(() => {}).finally(scheduleMaintenance);
    }, 60000);
    maintenanceTimer?.unref?.();
  }
  async function policy(caller) {
    caller.throwIfAborted();
    const settings = allowed();
    const state = await abortable(getDocumentStatus(caller), caller);
    caller.throwIfAborted();
    return { applications: [...settings.applications], contextApplications: [...settings.contextApplications], roots: [...(state.roots || [])] };
  }
  function safeApp(sample, settings) {
    const id = sample?.app?.id;
    if (!isApplicationId(id) || !settings.applications.includes(id)) return null;
    return { id, name: normalizeApplicationName(sample.app.name, catalog.get(id)?.name ?? id) };
  }
  async function read(caller) {
    const request = await policy(caller);
    if (!request.applications.length) return { sample: { app: null }, request };
    const result = await abortable(source.sample({ ...request, signal: caller }), caller);
    caller.throwIfAborted();
    if (result?.reason === 'SOURCE_UNAVAILABLE') throw new Error(publicFailure());
    const settings = allowed();
    const app = result?.reason === 'FOCUS_CHANGED' ? null : safeApp(result, settings);
    // Gate again on the exact request as well as current consent. Native extras,
    // process IDs and native timestamps are never authority or forwarded data.
    const selectedApp = app && request.applications.includes(app.id) ? app : null;
    const sample = { app: selectedApp };
    if (selectedApp && typeof result?.document?.path === 'string' && request.roots.length) sample.document = { path: result.document.path };
    if (selectedApp && request.contextApplications.includes(selectedApp.id) && settings.contextApplications.includes(selectedApp.id)) {
      const window = normalizeWindowHint(result?.window);
      if (window) sample.window = window;
    }
    return { sample, request, reason: result?.reason };
  }
  async function poll() {
    if (sampling) return sampling;
    if (disposed || !running || pendingMutations || !allowed().enabled || !allowed().applications.length) return;
    const epoch = generation;
    const own = new AbortController(); samplingAbort = own;
    const workSignal = combined(own.signal);
    sampling = (async () => {
      try {
        const { sample, reason } = await read(workSignal);
        if (disposed || pendingMutations || epoch !== generation || !allowed().enabled) return;
        // An uncertain focus race is not evidence of leaving the selected app.
        if (reason === 'FOCUS_CHANGED') return;
        await ledger.ingest(sample, workSignal);
        if (disposed || epoch !== generation) return;
        lastPollAt = new Date(now()).toISOString(); lastError = null;
        if (reason === 'accessibility_required_for_documents' && sourceFacts) sourceFacts = { ...sourceFacts, accessibilityTrusted: false, reason };
        cleanCues();
      } catch (error) {
        if (!disposed && epoch === generation && !workSignal.aborted) lastError = publicFailure();
      } finally {
        sampling = undefined; if (samplingAbort === own) samplingAbort = undefined;
        if (!disposed) schedule();
      }
    })();
    return sampling;
  }
  async function facts(caller, refresh = false) {
    caller.throwIfAborted();
    if (sourceFacts && !refresh && now() >= factsAt && now() - factsAt < 30000) return sourceFacts;
    const value = await abortable(source.status({ signal: caller }), caller);
    caller.throwIfAborted();
    sourceFacts = {
      available: value.available === true,
      accessibilityTrusted: value.accessibilityTrusted === true,
      applications: APPLICATIONS.map(app => {
        const installed = Array.isArray(value.applications) ? value.applications.find(item => item?.id === app.id)?.installed : null;
        return { ...app, installed: typeof installed === 'boolean' ? installed : null };
      }),
      ...(STATUS_REASONS.has(value.reason) ? { reason: value.reason } : {}),
    };
    factsAt = now();
    return sourceFacts;
  }
  function enrichCapabilities(capabilities) {
    const applications = new Map(capabilities.applications.map(app => [app.id, { ...app }]));
    // Explicitly discovered labels may enrich the UI, but never select an app.
    for (const app of discovered) {
      if (!applications.has(app.id) && applications.size >= MAX_ACTIVITY_APPLICATIONS) continue;
      applications.set(app.id, { id: app.id, name: app.name, installed: applications.get(app.id)?.installed ?? null });
    }
    return { ...capabilities, applications: [...applications.values()] };
  }
  function mutate(operation, caller) {
    // The fence is synchronous, even if a previous KV operation is draining.
    invalidate(); pendingMutations++;
    const workSignal = combined(caller, 20000);
    const result = mutationTail.then(async () => { workSignal.throwIfAborted(); return operation(workSignal); });
    mutationTail = result.catch(() => {});
    result.finally(() => { pendingMutations--; if (!disposed) schedule(0); }).catch(() => {});
    return result;
  }
  function releaseCurrent(token) {
    const cue = cues.get(token);
    if (cue?.expiryTimer !== undefined) clearTimer(cue.expiryTimer);
    if (cue?.sessionId && sessions.get(cue.sessionId) === token) sessions.delete(cue.sessionId);
    cues.delete(token);
  }
  const api = {
    getSettings: () => allowed(),
    async start() {
      if (disposed || running) return;
      running = true;
      await ledger.purge(combined());
      scheduleMaintenance(); schedule(0);
    },
    async status(caller, { refresh = false } = {}) {
      const workSignal = combined(caller);
      let capabilities;
      try { capabilities = await facts(workSignal, refresh); }
      catch (error) { workSignal.throwIfAborted(); capabilities = { available: false, accessibilityTrusted: false, applications: APPLICATIONS.map(app => ({ ...app, installed: null })) }; }
      const stats = typeof ledger.stats === 'function' ? await ledger.stats(workSignal) : {};
      workSignal.throwIfAborted();
      const settings = allowed();
      return { settings, capabilities: enrichCapabilities(capabilities), ...stats,
        state: !settings.enabled || !settings.applications.length ? 'paused' : !capabilities.available || lastError ? 'unavailable' : capabilities.accessibilityTrusted ? 'recording' : 'recording_apps',
        lastPollAt, lastError, retentionDays: ACTIVITY_RETENTION_DAYS, pollMs,
        note: '只记录已选择应用在前台出现的线索，不证明阅读、编辑或保存。本机文档须在授权文件夹内；窗口标题与去查询参数的 HTTPS 链接须另外逐应用授权。默认不启用额外窗口线索；不采正文、按键、剪贴板、截图或音频。',
      };
    },
    /** Human UI refresh only; never called by status, startup, sampling or tools. */
    async discoverApplications(caller) {
      const workSignal = combined(caller, 12000);
      return track((async () => {
        try {
          workSignal.throwIfAborted();
          if (typeof source.discoverApplications !== 'function') throw new Error(publicFailure());
          const value = await abortable(source.discoverApplications({ signal: workSignal }), workSignal);
          workSignal.throwIfAborted();
          if (value?.v !== 1 || value.platform !== 'darwin' || value.source !== 'jxa-applicationservices' || !Array.isArray(value.applications) || typeof value.truncated !== 'boolean') throw new Error(publicFailure());
          const applications = [], ids = new Set();
          let truncated = value.truncated || value.applications.length > MAX_ACTIVITY_APPLICATIONS;
          for (const item of value.applications.slice(0, MAX_ACTIVITY_APPLICATIONS)) {
            if (!isApplicationId(item?.id) || ids.has(item.id) || item.installed !== true || item.running !== true) { truncated = true; continue; }
            ids.add(item.id);
            applications.push({ id: item.id, name: normalizeApplicationName(item.name, item.id), installed: true, running: true, foreground: item.foreground === true });
          }
          workSignal.throwIfAborted();
          discovered = applications;
          return structuredClone({ applications, truncated });
        } catch {
          workSignal.throwIfAborted();
          throw new Error(publicFailure());
        }
      })());
    },
    async configure(change, caller) {
      return mutate(async workSignal => {
        // Removing the last app is a revocation, never an implicit request to
        // enable. Commit its safe pause atomically with app/context removal.
        // Host-only delta adapters supply a pure change function so concurrent
        // Owner views modify the latest serialized policy, never stale arrays.
        const update = { ...(typeof change === 'function' ? change(allowed()) : change) };
        if (Array.isArray(update.applications) && update.applications.length === 0 && update.enabled !== true) update.enabled = false;
        const next = { ...allowed(), ...update };
        if (next.enabled && !next.applications?.length) throw new Error('请先选择至少一个允许记录的软件。');
        const settings = await ledger.configure(update, workSignal);
        lastError = null;
        return { settings };
      }, caller);
    },
    async clear(caller) { return mutate(workSignal => ledger.clear(workSignal), caller); },
    async scopeChanged() {
      if (disposed) return;
      return mutate(workSignal => ledger.purge(workSignal));
    },
    async list(args = {}, caller) {
      const workSignal = AbortSignal.any([combined(caller, 12000), dataEpoch.signal]);
      await abortable(mutationTail, workSignal);
      workSignal.throwIfAborted();
      return ledger.list(args, workSignal);
    },
    async entry(id, caller) {
      const workSignal = AbortSignal.any([combined(caller, 12000), dataEpoch.signal]);
      await abortable(mutationTail, workSignal);
      workSignal.throwIfAborted();
      const value = await abortable(ledger.entry(id, workSignal), workSignal);
      workSignal.throwIfAborted();
      const settings = allowed();
      if (!value || value.id !== id || !settings.applications.includes(value.app?.id)) return null;
      let row = value;
      if (value.kind === 'window') {
        const window = settings.contextApplications.includes(value.app.id) ? normalizeWindowHint(value.window) : null;
        row = { id: value.id, app: value.app, observedAt: value.observedAt, kind: window ? 'window' : 'application', ...(window ? { window } : {}) };
      }
      const parsed = ActivityEntrySchema.safeParse(row);
      return parsed.success ? structuredClone(parsed.data) : null;
    },
    /** Called only for an explicit voice gesture, before the helper takes focus. */
    async captureCurrent(caller) {
      const epoch = generation;
      const workSignal = AbortSignal.any([combined(caller, 1800), dataEpoch.signal]);
      try {
        if (disposed || !running || pendingMutations || !allowed().applications.length) return null;
        const { sample } = await read(workSignal);
        if (disposed || pendingMutations || epoch !== generation || !sample.app) return null;
        let document;
        if (sample.document) {
          try {
            const parsed = ActivityDocumentSchema.safeParse(await abortable(validateDocument(sample.document.path, workSignal), workSignal));
            if (parsed.success) document = parsed.data;
          }
          catch { workSignal.throwIfAborted(); }
        }
        workSignal.throwIfAborted();
        if (disposed || epoch !== generation || !allowed().applications.includes(sample.app.id)) return null;
        const window = !document && allowed().contextApplications.includes(sample.app.id) ? normalizeWindowHint(sample.window) : null;
        cleanCues();
        while (cues.size >= 16) releaseCurrent(cues.keys().next().value);
        const token = randomUUID();
        const expiryTimer = setTimer(() => releaseCurrent(token), CURRENT_TTL); expiryTimer?.unref?.();
        cues.set(token, { generation: epoch, expiresAt: now() + CURRENT_TTL, expiryTimer, observedAt: new Date(now()).toISOString(), app: sample.app, ...(document ? { document } : window ? { window } : {}) });
        return token;
      } catch { return null; } // Optional context never breaks the working voice/file path.
    },
    bindCurrent(token, sessionId, caller) {
      caller?.throwIfAborted(); cleanCues();
      if (disposed || typeof token !== 'string' || !VOICE_SESSION.test(sessionId)) return false;
      const cue = cues.get(token);
      if (!cue || cue.generation !== generation || cue.sessionId && cue.sessionId !== sessionId) return false;
      const previous = sessions.get(sessionId);
      if (previous && previous !== token) releaseCurrent(previous);
      cue.sessionId = sessionId; sessions.set(sessionId, token); return true;
    },
    releaseCurrent,
    async currentForSession(sessionId, caller, { documents = true } = {}) {
      caller?.throwIfAborted(); cleanCues();
      const token = sessions.get(sessionId), cue = cues.get(token);
      if (!cue || cue.generation !== generation || !allowed().applications.includes(cue.app.id)) return null;
      const workSignal = AbortSignal.any([combined(caller), dataEpoch.signal]);
      let document;
      if (documents && cue.document) {
        try {
          const parsed = ActivityDocumentSchema.safeParse(await abortable(validateDocument(cue.document.path, workSignal), workSignal));
          if (parsed.success && parsed.data.path === cue.document.path && parsed.data.name === cue.document.name && parsed.data.kind === cue.document.kind) document = parsed.data;
        }
        catch { workSignal.throwIfAborted(); }
      }
      workSignal.throwIfAborted();
      if (disposed || cues.get(token) !== cue || cue.generation !== generation || cue.expiresAt <= now() || !allowed().applications.includes(cue.app.id)) return null;
      const window = documents && !document && allowed().contextApplications.includes(cue.app.id) ? normalizeWindowHint(cue.window) : null;
      return { kind: document ? 'document' : window ? 'window' : 'application', app: { ...cue.app }, observedAt: cue.observedAt, ...(document ? { document } : window ? { window } : {}), source: 'explicit_voice_gesture', temporary: true };
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true; running = false; signal?.removeEventListener('abort', parentAbort); invalidate();
      if (maintenanceTimer !== undefined) clearTimer(maintenanceTimer); maintenanceTimer = undefined;
      lifetime.abort(new Error('资料账本已卸载。'));
      disposal = (async () => {
        try { await source.dispose?.(); }
        finally { await Promise.allSettled([...tasks, ...(sampling ? [sampling] : []), mutationTail]); }
      })();
      return disposal;
    },
  };
  const parentAbort = () => { void api.dispose().catch(() => {}); };
  signal?.addEventListener('abort', parentAbort, { once: true });
  if (signal?.aborted) parentAbort();
  return Object.freeze(api);
}
