import { Service } from '@deepseek-ai/cordis';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATIONS, ActivityLedgerDomain, createActivityLedger } from './activity-ledger.js';
import { createMacActivitySource } from './activity-native.js';
import { createActivityController } from './activity-controller.js';
import { registerActivityRemote } from './activity-rpc.js';
import { normalizeActivityUrl, MAX_ACTIVITY_APPLICATIONS } from './activity-policy.js';

const lifecycleKey = Symbol.for('@local/deepseek-workfiles/activity/lifecycle-v1');
const generations = globalThis[lifecycleKey] ||= { disposal: Promise.resolve() };
const inaccessible = () => new Error('本地资料账本暂不可用，尚未开启记录；原有文件查找仍可使用。');

/** One bounded opening operation, shared by the Owner UI and Session-bound Tool.
 * Its caller supplies only an observed ID; never an arbitrary URL or command.
 */
export function createObservedLinkOpener({ getController, readSettings, native, combine, now = Date.now }) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  return async (id, caller, expected) => {
    if (typeof id !== 'string' || id.length !== 39 || !/^wa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) fail('UNKNOWN_CANDIDATE', '请先选择已记录的网页线索。');
    const controller = getController();
    if (!controller) throw inaccessible();
    const signal = combine(caller);
    signal.throwIfAborted();
    const entry = await controller.entry(id, signal);
    signal.throwIfAborted();
    const url = entry?.id === id && entry.kind === 'window' ? normalizeActivityUrl(entry.window?.url) : null;
    if (!url || url !== entry.window.url) fail('STALE_ACTIVITY', '这条网页线索已过期、被撤销，或没有可重新打开的地址。');
    const settings = controller.getSettings();
    if (!settings.applications.includes(entry.app.id) || !settings.contextApplications?.includes(entry.app.id)) fail('SCOPE_REVOKED', '这个软件的窗口线索许可已撤销。');
    if (expected && (expected.id !== id || expected.url !== url || expected.app?.id !== entry.app.id || expected.observedAt !== entry.observedAt)) fail('STALE_ACTIVITY', '网页线索与本次查询不再一致，请重新查询。');
    if (readSettings().enabled !== true) fail('SEARCH_DISABLED', '资料查找已暂停；请先恢复后再请求打开。');
    signal.throwIfAborted();
    await native(['/usr/bin/open', '--', url], { signal, timeout: 8000, maxBytes: 4096 });
    signal.throwIfAborted();
    return { status: 'open_requested', requestedAt: new Date(now()).toISOString() };
  };
}

/** Feature adapter: ordinary profile-owned local storage, explicit Human RPC,
 * and the existing managed subprocess. Does not create a Session or model turn.
 */
export async function installActivityFeature(ctx, { engine, readSettings, combine, configureFolders, native, signal }) {
  await generations.disposal;
  let domain, ledger, source, controller, voice, cleanup, storageError = null;
  const dispose = () => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      try { await controller?.dispose(); if (!controller) await source?.dispose(); }
      finally { try { await ledger?.dispose(); } finally { await domain?.close(); } }
    })();
    generations.disposal = cleanup; cleanup.catch(() => {}); return cleanup;
  };
  ctx.effect(() => dispose);
  const validateDocument = (filePath, caller) => engine.describeObservedDocument(filePath, combine(caller));
  const getDocumentStatus = async caller => ({ ...await engine.status(combine(caller)), enabled: readSettings().enabled });
  try {
    signal.throwIfAborted();
    domain = await ctx.storageDomain.open(ActivityLedgerDomain);
    signal.throwIfAborted();
    ledger = createActivityLedger({ domain, validateDocument });
    source = createMacActivitySource({ subprocess: ctx.subprocess, signal, bundleRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
    controller = createActivityController({ ledger, source, getDocumentStatus, validateDocument, signal });
  } catch (error) {
    await dispose().catch(() => {});
    controller = null; ledger = null; source = null; domain = null;
    if (signal.aborted) throw error;
    storageError = inaccessible().message;
  }
  // Optional dependency, not a root-level cycle: the voice entry already
  // requires workfiles. Its removal never retains a stale coordinator here.
  ctx.inject(['workfilesVoice'], child => {
    const current = child.workfilesVoice; voice = current;
    child.effect(() => () => { if (voice === current) voice = undefined; });
  });
  const requireController = () => { if (!controller) throw inaccessible(); return controller; };
  const requireVoice = () => { if (!voice) throw new Error('语音入口尚未就绪。请启用“工作资料语音入口”，原有文字查找仍可用。'); return voice; };
  const settings = () => controller?.getSettings() ?? { enabled: false, applications: [], contextApplications: [], retentionDays: 7 };
  const openObserved = createObservedLinkOpener({ getController: () => controller, readSettings, native, combine });
  const ledgerStatus = async (caller, refresh) => controller
    ? controller.status(caller, { refresh })
    : { settings: settings(), capabilities: { available: false, accessibilityTrusted: false, applications: APPLICATIONS.map(app => ({ ...app, installed: null })) }, state: 'unavailable', count: 0, lastError: storageError, retentionDays: 7 };
  const folders = caller => getDocumentStatus(caller);
  async function perform(input, caller) {
    signal.throwIfAborted(); caller?.throwIfAborted();
    switch (input.action) {
      case 'status': return { ledger: await ledgerStatus(caller, input.refresh === true), documents: await folders(caller), voice: voice?.status() ?? null };
      case 'configure': {
        const change = {};
        if (Object.hasOwn(input, 'enabled')) change.enabled = input.enabled;
        if (Object.hasOwn(input, 'applications')) change.applications = input.applications;
        if (Object.hasOwn(input, 'contextApplications')) change.contextApplications = input.contextApplications;
        return requireController().configure(change, caller);
      }
      case 'set_application': return requireController().configure(settings => ({
        applications: input.selected ? [...new Set([...settings.applications, input.id])] : settings.applications.filter(id => id !== input.id),
      }), caller);
      case 'set_context': return requireController().configure(settings => {
        if (input.allowed && !settings.applications.includes(input.id)) throw Object.assign(new Error('该软件已不在记录范围，请先明确选择应用。'), { code: 'SCOPE_REVOKED' });
        return { contextApplications: input.allowed ? [...new Set([...settings.contextApplications, input.id])] : settings.contextApplications.filter(id => id !== input.id) };
      }, caller);
      case 'discover_applications': return requireController().discoverApplications(caller);
      case 'select_running_applications': {
        const active = requireController(), found = await active.discoverApplications(caller);
        const result = await active.configure(settings => {
          const next = [...settings.applications];
          for (const app of found.applications) {
            if (next.length >= MAX_ACTIVITY_APPLICATIONS) break;
            if (!next.includes(app.id)) next.push(app.id);
          }
          return { applications: next };
        }, caller);
        return { ...result, discovered: { applications: found.applications.length, truncated: found.truncated === true || result.settings.applications.length >= MAX_ACTIVITY_APPLICATIONS } };
      }
      case 'open_observed': return openObserved(input.id, caller);
      case 'list': { const { action: _action, ...query } = input; return requireController().list(query, caller); }
      case 'clear': return requireController().clear(caller);
      case 'forget': return requireController().forget(input.id, caller);
      case 'open_accessibility':
        await native(['/usr/bin/open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], { signal: combine(caller, false), timeout: 8000, maxBytes: 4096 });
        return { status: 'open_requested', message: '已请求打开系统辅助功能设置。请由你手动授权；系统权限本身并非只读，本功能只使用受限读取。' };
      case 'folders': return folders(caller);
      case 'add_root': case 'remove_root':
        await configureFolders(input, combine(caller, false)); return folders(caller);
      case 'set_search_enabled':
        await configureFolders({ action: 'set_enabled', enabled: input.enabled }, combine(caller, false)); return folders(caller);
      case 'voice_status': return requireVoice().status();
      case 'voice_show': return requireVoice().open({ capture: false });
      case 'voice_record': return requireVoice().open({ capture: true });
      case 'voice_cancel': { const current = requireVoice(); current.cancel(); return current.status(); }
      case 'voice_shortcut': {
        const current = requireVoice();
        if (typeof current.configureShortcut !== 'function') throw new Error('请更新语音入口后再修改快捷键。');
        return current.configureShortcut(input.shortcut, { signal: caller });
      }
      default: throw new Error('未知的资料助手设置操作。');
    }
  }
  try {
    registerActivityRemote(ctx, perform, Service);
    await controller?.start();
  } catch (error) {
    await dispose().catch(() => {});
    controller = null; ledger = null; source = null; domain = null; storageError = inaccessible().message;
    throw error;
  }
  return Object.freeze({
    getController: () => controller,
    getSettings: settings,
    openObserved,
    captureCurrent: caller => controller?.captureCurrent(caller) ?? Promise.resolve(null),
    bindCurrent: (token, sessionId, caller) => controller?.bindCurrent(token, sessionId, caller) ?? false,
    releaseCurrent: token => controller?.releaseCurrent(token),
    scopeChanged: () => controller?.scopeChanged() ?? Promise.resolve(),
    dispose,
  });
}
