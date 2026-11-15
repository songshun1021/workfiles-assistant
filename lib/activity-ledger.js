import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { MAX_ACTIVITY_APPLICATIONS, ApplicationIdSchema, WindowHintSchema, normalizeWindowHint, normalizeApplicationName } from './activity-policy.js';

export const ACTIVITY_RETENTION_DAYS = 7;
export const MAX_ACTIVITY_ENTRIES = 1000;
const DAY_MS = 86400000;
const RETENTION_MS = ACTIVITY_RETENTION_DAYS * DAY_MS;
export const APPLICATIONS = Object.freeze([
  Object.freeze({ id: 'com.microsoft.Word', name: 'Microsoft Word' }),
  Object.freeze({ id: 'com.microsoft.Powerpoint', name: 'Microsoft PowerPoint' }),
  Object.freeze({ id: 'com.kingsoft.wpsoffice.mac', name: 'WPS Office' }),
]);
const catalog = new Map(APPLICATIONS.map(app => [app.id, app]));
const ApplicationIds = z.array(ApplicationIdSchema).max(MAX_ACTIVITY_APPLICATIONS).refine(values => new Set(values).size === values.length);
// Keep the legacy local-document decoder unchanged; new AX fields use policy.js.
const hasControl = value => /[\u0000-\u001f\u007f]/u.test(value);
const isLocalPath = value => typeof value === 'string' && value.length > 1 && value.length <= 8192 && !hasControl(value) && !value.includes('\\') && path.posix.isAbsolute(value) && !value.endsWith('/') && path.posix.normalize(value) === value;
const IsoDate = z.string().max(64).datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const LocalPath = z.string().max(8192).refine(isLocalPath);
export const ActivityDocumentSchema = z.object({
  name: z.string().min(1).max(4096).refine(value => !hasControl(value)),
  path: LocalPath,
  kind: z.enum(['presentation', 'document', 'spreadsheet', 'pdf', 'text']),
  modifiedAt: IsoDate,
}).strict().refine(value => value.name === path.posix.basename(value.path));
export const ActivitySettingsSchema = z.object({
  enabled: z.boolean(),
  applications: ApplicationIds,
  retentionDays: z.literal(ACTIVITY_RETENTION_DAYS),
  // Missing on version-1 legacy globals: decoding adds NO new metadata consent.
  contextApplications: ApplicationIds.default([]),
}).strict().refine(value => value.contextApplications.every(id => value.applications.includes(id)));
const SettingsChange = z.object({ enabled: z.boolean().optional(), applications: ApplicationIds.optional(), contextApplications: ApplicationIds.optional() }).strict();
const App = z.object({ id: ApplicationIdSchema, name: z.string().min(1).max(256).refine(value => normalizeApplicationName(value, '') === value) }).strict();
const EntryId = z.string().max(39).regex(/^wa-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u);
const entryFields = { id: EntryId, app: App, observedAt: IsoDate };
const ApplicationEntry = z.object({ ...entryFields, kind: z.literal('application') }).strict();
export const ActivityEntrySchema = z.discriminatedUnion('kind', [
  ApplicationEntry,
  z.object({ ...entryFields, kind: z.literal('document'), document: ActivityDocumentSchema }).strict(),
  z.object({ ...entryFields, kind: z.literal('window'), window: WindowHintSchema }).strict(),
]);
const Cursor = z.object({ appId: ApplicationIdSchema, key: z.string().regex(/^[0-9a-f]{64}$/u), observedAt: IsoDate.optional(), kind: z.enum(['application', 'document', 'window']).optional() }).strict();
const GlobalState = z.object({ settings: ActivitySettingsSchema, cursor: Cursor.nullable(), baselineNext: z.boolean() }).strict().refine(value => !value.cursor || value.settings.applications.includes(value.cursor.appId) && (value.cursor.kind !== 'window' || value.settings.contextApplications.includes(value.cursor.appId)));
const initial = Object.freeze({
  settings: Object.freeze({ enabled: false, applications: Object.freeze([]), retentionDays: ACTIVITY_RETENTION_DAYS, contextApplications: Object.freeze([]) }),
  cursor: null,
  baselineNext: false,
});
/** Real StorageDomain contract: the caller opens/closes this domain. No model memory is stored here. */
export const ActivityLedgerDomain = Object.freeze({
  name: 'local_workfiles_activity', version: 1, layout: 'per-record',
  global: Object.freeze({ schema: GlobalState, initial }),
  tables: Object.freeze({ entries: Object.freeze({ valueSchema: ActivityEntrySchema }) }),
});
const Snapshot = z.object({
  app: z.object({ id: z.string().min(1).max(255), name: z.string().max(256).optional(), pid: z.number().int().positive().optional() }).strict().nullable(),
  document: z.object({ path: z.string().max(8192), title: z.string().max(4096).optional() }).strict().optional(),
  // Deliberately opaque until AFTER selection and context consent checks.
  window: z.unknown().optional(),
}).strict();
const Query = z.object({
  query: z.string().max(512).optional(), after: IsoDate.optional(), before: IsoDate.optional(),
  kind: z.enum(['application', 'document', 'window', 'all']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict().refine(value => !value.after || !value.before || Date.parse(value.after) < Date.parse(value.before));
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => isDeepStrictEqual(a, b);
const safeParse = (schema, value) => { try { const parsed = schema.safeParse(value); return parsed.success ? parsed.data : null; } catch { return null; } };
const applicationOnly = value => ({ id: value.id, kind: 'application', app: value.app, observedAt: value.observedAt });
function entryEnvelope(raw) {
  try {
    if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const kind = descriptors.kind?.value;
    const fields = ['id', 'app', 'observedAt', 'kind', ...(kind === 'document' ? ['document'] : kind === 'window' ? ['window'] : [])];
    if (!['application', 'document', 'window'].includes(kind) || Reflect.ownKeys(raw).some(key => !fields.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) return null;
    if (!['id', 'app', 'observedAt', 'kind'].every(key => Object.hasOwn(descriptors, key))) return null;
    // Do not touch document/window fields: app-only reads project before validation.
    return safeParse(ApplicationEntry, { id: descriptors.id.value, app: descriptors.app.value, observedAt: descriptors.observedAt.value, kind: 'application' });
  } catch { return null; }
}
function failure(code, message, cause) { return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code }); }
function throwAborted(signal) { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); }
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    try { Promise.resolve(operation()).then(value => finish(resolve, value), error => finish(reject, error)); }
    catch (error) { finish(reject, error); }
  });
}

/**
 * Pure ledger: storage handles and a scoped, read-only document validator are injected.
 * It never enumerates applications, reads a user file, starts a sampler, or opens an Agent.
 * validateDocument(path, signal) must return ONLY { name, path, kind, modifiedAt } after
 * current scope/canonical-path checks; persisted paths are revalidated, never authority.
 */
export function createActivityLedger({ domain, now = Date.now, validateDocument }) {
  if (!domain?.global || typeof domain.global.get !== 'function' || typeof domain.global.set !== 'function' || typeof domain.table !== 'function' || typeof now !== 'function' || typeof validateDocument !== 'function') {
    throw failure('INVALID_ACTIVITY_DEPENDENCY', '资料账本依赖无效。');
  }
  let state = safeParse(GlobalState, domain.global.get());
  if (!state) throw failure('INVALID_ACTIVITY_STORAGE', '资料账本设置无效，未开启记录。');
  const table = domain.table('entries');
  if (!table || !['get', 'entries', 'put', 'deleteMany'].every(method => typeof table[method] === 'function')) throw failure('INVALID_ACTIVITY_DEPENDENCY', '资料账本存储接口无效。');
  let intent = clone(state.settings), tail = Promise.resolve(), epoch = new AbortController();
  let generation = 0, sampleVersion = 0, disposed = false, faulted = false, clearing = 0;
  const controls = [];
  const applyChange = (settings, change) => {
    const next = { ...settings, ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)), retentionDays: ACTIVITY_RETENTION_DAYS };
    if (change.contextApplications === undefined) next.contextApplications = settings.contextApplications.filter(id => next.applications.includes(id));
    return next;
  };
  const projectIntent = () => {
    intent = controls.reduce((settings, control) => {
      const next = applyChange(settings, control.change);
      // A queued expansion may depend on an earlier operation that later fails.
      // Invalid combinations never become effective consent while they drain.
      return { ...next, contextApplications: next.contextApplications.filter(id => next.applications.includes(id)) };
    }, clone(state.settings));
  };
  let activeSample = null, lastInput = null, resolvedInput = null, suppressedRawKey = null, disposal;
  const enqueue = operation => { const result = tail.then(operation); tail = result.catch(() => {}); return result; };
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw failure('INVALID_ACTIVITY_CLOCK', '资料账本时钟无效。');
    return value;
  };
  const assertOpen = () => { if (disposed) throw failure('ACTIVITY_DISPOSED', '资料账本已经关闭。'); };
  const effective = () => {
    // Every outstanding restriction applies immediately. A later queued re-grant
    // must not undo a revoke/pause before BOTH durable operations have drained.
    const applications = state.settings.applications.filter(id => controls.every(({ change }) => change.applications === undefined || change.applications.includes(id)));
    return {
      enabled: !disposed && !faulted && state.settings.enabled && controls.every(({ change }) => change.enabled !== false),
      applications,
      retentionDays: ACTIVITY_RETENTION_DAYS,
      contextApplications: state.settings.contextApplications.filter(id => applications.includes(id) && controls.every(({ change }) => change.contextApplications === undefined || change.contextApplications.includes(id))),
    };
  };
  const invalidate = () => {
    generation++;
    epoch.abort(new DOMException('Activity policy changed', 'AbortError'));
    epoch = new AbortController();
    activeSample?.controller.abort(new DOMException('Activity policy changed', 'AbortError'));
    resolvedInput = null;
  };
  const ticket = (signal, sample) => ({
    generation, sample, caller: signal,
    signal: AbortSignal.any([epoch.signal, ...(signal ? [signal] : []), ...(sample === undefined ? [] : [activeSample.controller.signal])]),
  });
  const live = token => !disposed && token.generation === generation && !token.signal.aborted && (token.sample === undefined || token.sample === sampleVersion);
  const dataLive = (token, appId) => live(token) && !clearing && effective().enabled && effective().applications.includes(appId);
  const stale = token => { throwAborted(token.caller); return { recorded: false, reason: disposed ? 'disposed' : 'stale' }; };
  const storageFailure = error => { faulted = true; invalidate(); return failure('ACTIVITY_STORAGE_UNAVAILABLE', '资料账本保存失败，本次运行已停止自动记录。', error); };
  const cursorFor = (appId, document, window) => ({
    appId, key: hash(`${appId}\u0000${document ? `document\u0000${document.path}` : window ? `window\u0000${JSON.stringify(window)}` : 'application'}`),
    observedAt: new Date(time()).toISOString(), kind: document ? 'document' : window ? 'window' : 'application',
  });
  const cursorLive = (stamp = time()) => !!state.cursor?.observedAt && Date.parse(state.cursor.observedAt) > stamp - RETENTION_MS && Date.parse(state.cursor.observedAt) <= stamp;
  async function validate(documentPath, token) {
    if (!isLocalPath(documentPath) || !live(token)) return null;
    try {
      const result = await abortable(() => validateDocument(documentPath, token.signal), token.signal);
      if (!live(token)) return null;
      const parsed = safeParse(ActivityDocumentSchema, result);
      return parsed ? { ...parsed, modifiedAt: new Date(parsed.modifiedAt).toISOString() } : null;
    } catch {
      throwAborted(token.caller);
      return null;
    }
  }
  function readRows(appOnly = false) {
    const rows = [], invalid = [], replacements = [];
    const context = new Set(effective().contextApplications);
    let order = 0;
    for (const [key, raw] of table.entries()) {
      const envelope = entryEnvelope(raw);
      let value = envelope;
      if (envelope && !appOnly) {
        if (raw.kind === 'window') {
          // Re-canonicalize on every contextual read; stored URLs are not authority.
          const window = context.has(envelope.app.id) ? normalizeWindowHint(raw.window) : null;
          value = window ? { ...envelope, kind: 'window', window } : envelope;
        } else value = safeParse(ActivityEntrySchema, raw);
      }
      if (!value || value.id !== key || !safeParse(EntryId, key)) { invalid.push(key); continue; }
      if (!appOnly && !same(value, raw)) replacements.push({ key, before: raw, value });
      rows.push({ key, value, before: raw, order: order++ });
    }
    return { rows, invalid, replacements };
  }
  function retained(snapshot, stamp) {
    const selected = new Set(effective().applications), deleted = new Set(snapshot.invalid);
    const rows = snapshot.rows.filter(row => {
      const observed = Date.parse(row.value.observedAt);
      if (!selected.has(row.value.app.id) || observed <= stamp - RETENTION_MS || observed > stamp) { deleted.add(row.key); return false; }
      return true;
    }).sort((a, b) => Date.parse(b.value.observedAt) - Date.parse(a.value.observedAt) || b.order - a.order);
    for (const row of rows.splice(MAX_ACTIVITY_ENTRIES)) deleted.add(row.key);
    return { rows, deleted, replacements: (snapshot.replacements ?? []).filter(row => !deleted.has(row.key)) };
  }
  async function maintenance(plan, token) {
    if (!live(token)) return 0;
    let removed = 0;
    if (plan.deleted.size) removed = await table.deleteMany([...plan.deleted]);
    for (const { key, before, value } of plan.replacements ?? []) {
      if (!live(token)) break;
      // An old query must never resurrect a record removed by a concurrent clear.
      if (same(table.get(key), before)) await table.put(key, clone(value));
    }
    if (live(token) && state.cursor && (!cursorLive() || state.cursor.kind === 'window' && !effective().contextApplications.includes(state.cursor.appId))) {
      const following = { ...state, cursor: null };
      await domain.global.set(clone(following));
      state = following; suppressedRawKey = null;
    }
    return removed;
  }
  function getSettings() { return clone(effective()); }

  async function configure(change, signal) {
    assertOpen(); throwAborted(signal);
    const parsed = safeParse(SettingsChange, change);
    if (!parsed || !safeParse(ActivitySettingsSchema, applyChange(intent, parsed))) throw failure('INVALID_ACTIVITY_INPUT', '资料记录设置无效。');
    if (!controls.length && !faulted && same(applyChange(state.settings, parsed), state.settings)) return getSettings();
    const control = { change: parsed };
    controls.push(control); projectIntent(); invalidate();
    try {
      return await enqueue(async () => {
        try {
          assertOpen(); throwAborted(signal);
          // Derive from committed settings, not an earlier failed/cancelled consent expansion.
          const next = safeParse(ActivitySettingsSchema, applyChange(state.settings, control.change));
          if (!next) throw failure('INVALID_ACTIVITY_INPUT', '资料记录设置无效。');
          const selected = new Set(next.applications), context = new Set(next.contextApplications);
          const snapshot = readRows();
          const revoked = [...snapshot.invalid, ...snapshot.rows.filter(row => !selected.has(row.value.app.id)).map(row => row.key)];
          if (revoked.length) await table.deleteMany(revoked);
          for (const row of snapshot.rows) {
            if (!selected.has(row.value.app.id)) continue;
            const value = row.value.kind === 'window' && !context.has(row.value.app.id) ? applicationOnly(row.value) : row.value;
            if (!same(value, row.before) && same(table.get(row.key), row.before)) await table.put(row.key, clone(value));
          }
          assertOpen(); throwAborted(signal);
          const before = clone(state);
          const cursor = state.cursor && selected.has(state.cursor.appId) && (state.cursor.kind !== 'window' || context.has(state.cursor.appId)) ? state.cursor : null;
          const following = { ...state, settings: clone(next), cursor };
          await domain.global.set(clone(following));
          if (disposed || signal?.aborted) {
            // Storage writes cannot be cancelled. Never leave a late consent expansion behind.
            const widens = following.settings.enabled && !before.settings.enabled || following.settings.applications.some(id => !before.settings.applications.includes(id)) || following.settings.contextApplications.some(id => !before.settings.contextApplications.includes(id));
            if (widens) await domain.global.set(before);
            else state = following;
            assertOpen(); throwAborted(signal);
          }
          state = following; faulted = false;
          if (!following.cursor) suppressedRawKey = null;
        } finally {
          controls.splice(controls.indexOf(control), 1);
          projectIntent();
        }
        return getSettings();
      });
    } catch (error) {
      if (error?.code === 'INVALID_ACTIVITY_INPUT') throw error;
      faulted = true; invalidate();
      if (error?.code === 'ACTIVITY_DISPOSED' || signal?.aborted) throw error;
      throw storageFailure(error);
    }
  }

  async function ingest(snapshot, signal) {
    if (disposed) return { recorded: false, reason: 'disposed' };
    throwAborted(signal);
    const policy = effective();
    if (!policy.enabled) return { recorded: false, reason: 'disabled' };
    if (clearing) return { recorded: false, reason: 'clearing' };
    const parsed = safeParse(Snapshot, snapshot);
    if (!parsed) return { recorded: false, reason: 'invalid' };
    if (!parsed.app || !policy.applications.includes(parsed.app.id)) {
      activeSample?.controller.abort(new DOMException('Foreground source no longer selected', 'AbortError'));
      sampleVersion++; activeSample = null; lastInput = null; resolvedInput = null;
      // An unselected foreground is a transition, not a record. Forget only the
      // previous dedup cursor, never the unselected app's identity. Otherwise a
      // single selected app could be suppressed forever across Edge → Word.
      const token = ticket(signal);
      try {
        return await enqueue(async () => {
          if (!live(token)) return stale(token);
          if (state.cursor) {
            const following = { ...state, cursor: null };
            await domain.global.set(clone(following));
            state = following; suppressedRawKey = null;
          }
          throwAborted(signal);
          return { recorded: false, reason: 'unselected' };
        });
      } catch (error) {
        throwAborted(signal); if (!live(token)) return stale(token);
        throw storageFailure(error);
      }
    }
    const appId = parsed.app.id;
    const app = { id: appId, name: normalizeApplicationName(parsed.app.name, catalog.get(appId)?.name ?? appId) };
    const inputPath = isLocalPath(parsed.document?.path) ? parsed.document.path : null;
    const hint = policy.contextApplications.includes(appId) ? normalizeWindowHint(parsed.window) : null;
    const rawKey = hash(`${appId}\u0000${inputPath ?? 'application'}${hint ? `\u0000window\u0000${JSON.stringify(hint)}` : ''}`);
    lastInput = { appId, rawKey };
    if (activeSample && activeSample.rawKey !== rawKey) {
      activeSample.controller.abort(new DOMException('A newer foreground observation arrived', 'AbortError'));
      activeSample = null; sampleVersion++; resolvedInput = null;
    }
    if (suppressedRawKey === rawKey && !state.baselineNext && cursorLive()) return { recorded: false, reason: 'duplicate' };
    if (activeSample?.rawKey === rawKey) return { recorded: false, reason: 'pending' };
    activeSample?.controller.abort(new DOMException('A newer foreground observation arrived', 'AbortError'));
    const holder = { rawKey, controller: new AbortController(), version: ++sampleVersion };
    activeSample = holder;
    const token = ticket(signal, holder.version);
    let insertedId;
    try {
      const observed = time();
      const document = inputPath ? await validate(inputPath, token) : null;
      if (!dataLive(token, appId)) return stale(token);
      const window = !document && effective().contextApplications.includes(appId) ? hint : null;
      const cursor = cursorFor(appId, document, window);
      resolvedInput = { ...lastInput, cursor, generation, sample: holder.version };
      return await enqueue(async () => {
        try {
        if (!dataLive(token, appId)) return stale(token);
        if (observed <= time() - RETENTION_MS || observed > time()) return { recorded: false, reason: 'expired' };
        if (state.baselineNext) {
          const following = { ...state, cursor, baselineNext: false };
          await domain.global.set(clone(following));
          if (!dataLive(token, appId)) return stale(token);
          state = following; suppressedRawKey = rawKey;
          return { recorded: false, reason: 'baseline' };
        }
        if (state.cursor?.key === cursor.key && cursorLive()) return { recorded: false, reason: 'duplicate' };
        const entry = ActivityEntrySchema.parse({ id: `wa-${randomUUID()}`, kind: document ? 'document' : window ? 'window' : 'application', app, observedAt: new Date(observed).toISOString(), ...(document ? { document } : window ? { window } : {}) });
        insertedId = entry.id;
        await table.put(entry.id, clone(entry));
        if (!dataLive(token, appId)) {
          await table.deleteMany([entry.id]);
          return stale(token);
        }
        const plan = retained(readRows(), time());
        if (plan.deleted.size) await table.deleteMany([...plan.deleted]);
        if (!dataLive(token, appId)) {
          await table.deleteMany([entry.id]);
          return stale(token);
        }
        const following = { ...state, cursor, baselineNext: false };
        await domain.global.set(clone(following));
        if (!dataLive(token, appId)) {
          await table.deleteMany([entry.id]);
          return stale(token);
        }
        state = following; suppressedRawKey = null;
        return { recorded: true, reason: 'recorded', entry: clone(entry) };
        } catch (error) {
          // Compensation belongs to the same queued job, so dispose() joins it too.
          if (insertedId) await table.deleteMany([insertedId]);
          throw error;
        }
      });
    } catch (error) {
      throwAborted(signal);
      if (!live(token)) return stale(token);
      throw storageFailure(error);
    } finally { if (activeSample === holder) activeSample = null; }
  }

  async function inspectRows(options, signal, purgeAll = false, token = ticket(signal)) {
    const stamp = time();
    let snapshot;
    try { snapshot = await abortable(() => enqueue(() => live(token) ? readRows(!purgeAll && options.kind === 'application') : { rows: [], invalid: [] }), token.signal); }
    catch { throwAborted(signal); return { entries: [], removed: 0 }; }
    if (!live(token)) { throwAborted(signal); return { entries: [], removed: 0 }; }
    const plan = retained(snapshot, stamp);
    const limit = options.limit ?? 8;
    const words = (options.query ?? '').normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const matches = value => {
      const text = `${value.app.name}\n${value.app.id}\n${value.kind === 'document' ? `${value.document.name}\n${value.document.path}` : value.kind === 'window' ? `${value.window.title ?? ''}\n${value.window.url ?? ''}` : ''}`.normalize('NFKC').toLocaleLowerCase();
      return words.every(word => text.includes(word));
    };
    const within = value => (!options.after || Date.parse(value.observedAt) >= Date.parse(options.after)) && (!options.before || Date.parse(value.observedAt) < Date.parse(options.before));
    const desiredKind = value => options.kind === 'document' ? value.kind !== 'application' : options.kind === 'window' ? value.kind === 'window' : true;
    // Collapse repeated views of the SAME page or file. Application rows stay a plain
    // timeline; the per-app aggregate already answers “which apps”.
    const identity = value => value.kind === 'window' ? `window\u0000${value.app.id}\u0000${value.window.url ?? `title:${value.window.title ?? ''}`}`
      : value.kind === 'document' ? `document\u0000${value.document.path}` : null;
    // Same page seen again (cursor reset, tab return) collapses into one row with a count.
    const collapsed = new Map();
    const documents = new Map(), result = [], applications = new Map();
    let matchedCount = 0;
    for (const row of plan.rows) {
      if (!live(token)) break;
      // readRows projected app-only questions BEFORE touching metadata schemas.
      let value = row.value;
      if (!purgeAll && (options.id && value.id !== options.id || !within(value) || !matches(value) || !desiredKind(value))) continue;
      if (value.kind === 'document') {
        const stored = value.document;
        if (!documents.has(stored.path)) documents.set(stored.path, validate(stored.path, token));
        const checked = await documents.get(stored.path);
        if (!live(token)) break;
        if (!checked || checked.path !== stored.path || checked.name !== stored.name || checked.kind !== stored.kind) {
          value = applicationOnly(value);
          plan.replacements.push({ key: row.key, before: row.before, value });
        }
      }
      if (!purgeAll && within(value) && matches(value) && desiredKind(value)) {
        matchedCount++;
        const group = applications.get(value.app.id);
        if (group) group.observations++;
        else applications.set(value.app.id, { app: clone(value.app), lastObservedAt: value.observedAt, observations: 1 });
        const key = identity(value);
        if (!key) { if (result.length < limit) result.push(clone(value)); continue; }
        const existing = collapsed.get(key);
        if (existing) { existing.observations += 1; continue; }
        if (result.length >= limit) continue;
        const entry = { ...clone(value), observations: 1 };
        collapsed.set(key, entry);
        result.push(entry);
      }
    }
    if (!live(token)) { throwAborted(signal); return { entries: [], removed: 0 }; }
    let removed;
    try { removed = await enqueue(() => maintenance(plan, token)); }
    catch (error) { throw storageFailure(error); }
    if (!live(token)) { throwAborted(signal); return { entries: [], removed }; }
    return { entries: result, removed, applications: [...applications.values()], matchedCount, truncated: matchedCount > result.length };
  }
  async function list(options = {}, signal) {
    assertOpen(); throwAborted(signal);
    const parsed = safeParse(Query, options);
    if (!parsed) throw failure('INVALID_ACTIVITY_INPUT', '资料记录查询条件无效。');
    const result = await inspectRows(parsed, signal);
    return { entries: result.entries, applications: result.applications ?? [], matchedCount: result.matchedCount ?? 0, truncated: result.truncated ?? false, retentionDays: ACTIVITY_RETENTION_DAYS };
  }
  /** An observed ID is a lookup, not authorization: re-check retention and consent. */
  async function entry(id, signal) {
    assertOpen(); throwAborted(signal);
    if (!safeParse(EntryId, id)) return null;
    const result = await inspectRows({ id, limit: 1 }, signal);
    const value = result.entries[0], stamp = time();
    // A validation/KV wait may itself cross the retention boundary. A link ID
    // never gains extra lifetime just because its lookup started earlier.
    if (!value || Date.parse(value.observedAt) <= stamp - RETENTION_MS || Date.parse(value.observedAt) > stamp || !effective().applications.includes(value.app.id)) return null;
    return clone(value.kind === 'window' && !effective().contextApplications.includes(value.app.id) ? applicationOnly(value) : value);
  }
  async function stats(signal) {
    assertOpen(); throwAborted(signal);
    const token = ticket(signal), stamp = time();
    try {
      const result = await enqueue(async () => {
        if (!live(token)) return { count: 0, lastObservedAt: null, retentionDays: ACTIVITY_RETENTION_DAYS };
        const plan = retained(readRows(), stamp);
        await maintenance(plan, token);
        if (!live(token)) return { count: 0, lastObservedAt: null, retentionDays: ACTIVITY_RETENTION_DAYS };
        return { count: plan.rows.length, lastObservedAt: plan.rows[0]?.value.observedAt ?? null, retentionDays: ACTIVITY_RETENTION_DAYS };
      });
      throwAborted(signal);
      return result;
    } catch (error) {
      throwAborted(signal);
      throw storageFailure(error);
    }
  }
  async function purge(signal) {
    assertOpen(); throwAborted(signal);
    invalidate();
    const result = await inspectRows({}, signal, true, ticket(signal));
    return { removed: result.removed };
  }
  /** Delete one stored clue by the id a Human already saw in the list. Malformed or
   * unknown ids are a no-op: this can never become "delete by path" or a bulk erase. */
  async function forget(id, signal) {
    assertOpen(); throwAborted(signal);
    if (!safeParse(EntryId, id)) throw failure('INVALID_ACTIVITY_INPUT', '资料线索标识无效。');
    invalidate();
    try {
      return await enqueue(async () => {
        assertOpen(); throwAborted(signal);
        const removed = await table.deleteMany([id]);
        return { removed: removed ? 1 : 0 };
      });
    } catch (error) {
      if (error?.code === 'ACTIVITY_DISPOSED' || signal?.aborted) throw error;
      throw storageFailure(error);
    }
  }
  async function clear(signal) {
    assertOpen(); throwAborted(signal);
    const known = resolvedInput && resolvedInput.generation === generation && resolvedInput.sample === sampleVersion && resolvedInput.rawKey === lastInput?.rawKey;
    const cursor = known ? resolvedInput.cursor : state.cursor;
    const baselineNext = !known;
    const suppressed = known ? lastInput.rawKey : null;
    invalidate(); clearing++;
    try {
      return await enqueue(async () => {
        assertOpen(); throwAborted(signal);
        const keys = [...table.entries()].map(([key]) => key);
        const cleared = keys.length ? await table.deleteMany(keys) : 0;
        // Once erasure starts, finish the non-content tombstone even if the caller cancels.
        const currentCursor = known ? cursor : state.cursor;
        const selectedCursor = currentCursor && state.settings.applications.includes(currentCursor.appId) && (currentCursor.kind !== 'window' || state.settings.contextApplications.includes(currentCursor.appId)) ? { ...currentCursor, observedAt: new Date(time()).toISOString() } : null;
        const following = { ...state, cursor: selectedCursor, baselineNext: baselineNext || !selectedCursor };
        await domain.global.set(clone(following));
        state = following; suppressedRawKey = selectedCursor ? suppressed : null;
        throwAborted(signal);
        return { cleared };
      });
    } catch (error) {
      if (error?.code === 'ACTIVITY_DISPOSED' || signal?.aborted) throw error;
      throw storageFailure(error);
    } finally { clearing--; }
  }
  function dispose() {
    if (disposal) return disposal;
    disposed = true; invalidate();
    disposal = tail.then(() => undefined);
    return disposal;
  }
  return Object.freeze({ getSettings, configure, ingest, list, entry, forget, stats, clear, purge, dispose });
}
