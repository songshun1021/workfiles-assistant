import Schema from '@deepseek-ai/schemastery';
import { createDocumentEngine, WorkfilesError } from './lib/documents.js';
import { createNativeRunner } from './lib/native.js';
import { contextProjection } from './lib/context.js';
import { createOperations, createSessionGate } from './lib/operations.js';
import { createToolDefinitions, WORKFILES_PROMPT } from './lib/tools.js';

export const inject = ['fs', 'subprocess', 'tools', 'systemPrompt', 'sessionProjections', 'commands', 'configEditor', 'storageDomain', 'typert'];
export const Config = Schema.object({
  roots: Schema.array(Schema.string()).default([]).description('用户明确允许查找的资料文件夹；最多 8 个，不允许整个电脑或整个个人目录。').volatile(),
  enabled: Schema.boolean().default(true).description('是否允许按需查找和打开文件。独立的最近资料账本须在“资料助手”里手动开启，本开关不代替暂停记录。').volatile(),
});
function current(field, fallback) { return field && typeof field.get === 'function' ? field.get() : field ?? fallback; }
function parseInput(raw) {
  if (typeof raw !== 'string' || raw.length > 16384) throw new WorkfilesError('INVALID_INPUT', '操作内容过长或无效。');
  const value = JSON.parse(raw.trim() || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkfilesError('INVALID_INPUT', '操作内容无效。');
  return value;
}

export async function apply(ctx, config) {
  const lifecycle = new AbortController();
  ctx.effect(() => () => lifecycle.abort(new Error('工作资料助手已卸载。')));
  const projection = await ctx.sessionProjections.register(contextProjection());
  ctx.effect(() => () => projection.dispose());
  const gate = createSessionGate();
  ctx.effect(() => () => gate.dispose());
  const rawSettings = () => ({ roots: [...current(config.roots, [])], enabled: current(config.enabled, true) });
  let activityFeature, scopeLifetime = new AbortController(), settingsSignature = JSON.stringify(rawSettings());
  const invalidateScope = () => {
    settingsSignature = JSON.stringify(rawSettings());
    scopeLifetime.abort(new Error('资料范围或暂停状态已改变，请重新操作。')); scopeLifetime = new AbortController();
    const cleanup = activityFeature?.scopeChanged();
    cleanup?.catch(() => {}); return cleanup;
  };
  // Volatile's public contract has get(), not a subscription. Observe its
  // immutable snapshot at every admission/check as well as Human edits, so a
  // Plugin Manager change cannot keep a previous scope alive.
  const readSettings = () => {
    const value = rawSettings();
    if (JSON.stringify(value) !== settingsSignature) invalidateScope();
    return value;
  };
  ctx.effect(() => () => scopeLifetime.abort());
  const combine = (signal, includeScope = true) => {
    if (includeScope) readSettings();
    return AbortSignal.any([...(signal ? [signal] : []), lifecycle.signal, ...(includeScope ? [scopeLifetime.signal] : []), AbortSignal.timeout(25000)]);
  };
  const native = createNativeRunner(ctx.subprocess);
  const engine = createDocumentEngine({ fs: ctx.fs, runNative: native, roots: () => readSettings().roots, enabled: () => readSettings().enabled });
  const operations = createOperations({
    engine, getContext: session => projection.stateOf(session).context, getTurn: session => projection.stateOf(session).turn ?? 0, getSettings: readSettings, getActivity: () => activityFeature?.getController(), onScopeChange: invalidateScope,
    openObserved: (id, caller, expected) => {
      if (!activityFeature) throw new WorkfilesError('ACTIVITY_UNAVAILABLE', '最近资料账本暂不可用。');
      return activityFeature.openObserved(id, caller, expected);
    },
    async saveSettings(change, signal) {
      const entry = ctx.fiber.entry;
      if (entry === undefined) throw new WorkfilesError('SETTINGS_UNAVAILABLE', '当前运行方式无法保存插件设置。');
      await ctx.configEditor.edit(entry, before => {
        signal?.throwIfAborted();
        const live = readSettings();
        const latest = { roots: Array.isArray(before.roots) ? before.roots : live.roots, enabled: typeof before.enabled === 'boolean' ? before.enabled : live.enabled };
        return { ...before, ...change(latest) };
      });
    },
  });
  try {
    const { installActivityFeature } = await import('./lib/activity-host.js');
    activityFeature = await installActivityFeature(ctx, { engine, readSettings, combine, native, signal: lifecycle.signal,
      configureFolders: (args, signal) => operations.configure(args, signal) });
  } catch {
    // A new optional capability must not remove the working file-search path.
    // Its owned effect still closes any partially initialized resources.
  }
  ctx.provide('workfiles', {
    ...operations,
    // Internal Host seams. Current cues are opaque, short-lived and bound only
    // to the ordinary Voice Session; no private model memory or permission tool.
    captureCurrent: signal => activityFeature?.captureCurrent(signal) ?? Promise.resolve(null),
    bindCurrent: (token, sessionId, signal) => activityFeature?.bindCurrent(token, sessionId, signal) ?? false,
    releaseCurrent: token => activityFeature?.releaseCurrent(token),
    async status(signal) {
      const activity = activityFeature?.getSettings();
      return { ...await engine.status(combine(signal)), enabled: readSettings().enabled,
        activityAllowed: !!activity?.applications.length, activityRecording: activity?.enabled === true };
    },
  });
  ctx.on('session/event', (session, event) => gate.committed(session, event));
  const invoke = (agent, action, args, signal, key, waitForCommit) => {
    if (!agent?.session) throw new WorkfilesError('SESSION_REQUIRED', '请在一个 DeepSeek 对话中使用资料助手。');
    const combined = combine(signal);
    return gate.run(agent.session, key, waitForCommit, () => operations.run(agent, action, args, combined), combined);
  };
  for (const tool of createToolDefinitions((exec, action, args) => {
    const logged = !!exec.agent && Object.hasOwn(projection.stateOf(exec.agent.session).tools, exec.callId);
    return invoke(exec.agent, action, args, exec.signal, `t:${exec.callId}`, logged);
  })) ctx.tools.register(tool);

  ctx.commands.register({
    name: 'workfiles', definitionId: '@local/deepseek-workfiles/action',
    description: '工作资料助手：查看范围和候选、查找、读取或打开资料。', input: { hint: '操作内容（由资料助手面板填写）' },
    async handler({ agent, rawInput, signal, commandId }) {
      const input = parseInput(rawInput);
      if (!['context', 'search', 'inspect', 'open'].includes(input.action)) throw new WorkfilesError('INVALID_ACTION', '未知的资料操作。');
      const args = input.args ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new WorkfilesError('INVALID_INPUT', '资料操作参数无效。');
      const result = await invoke(agent, input.action, args, signal, `c:${commandId}`, true);
      return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) };
    },
  });
  ctx.commands.register({
    name: 'workfiles-config', definitionId: '@local/deepseek-workfiles/configure',
    description: '仅用户操作：选择资料文件夹、移除范围或暂停文件查找；账本记录由资料助手里的独立开关控制。', input: { hint: '设置内容（由资料助手面板填写）' },
    async handler({ rawInput, signal }) {
      const result = await operations.configure(parseInput(rawInput), combine(signal, false));
      return { kind: 'success', text: JSON.stringify(result) };
    },
  });
  ctx.systemPrompt.section({ name: 'local-workfiles-assistant', order: 95, text: WORKFILES_PROMPT });
  // Run before asynchronous feature teardown, not after it: in-flight file
  // operations lose authority immediately when the plugin is disabled/reloaded.
  ctx.effect(() => () => { lifecycle.abort(new Error('工作资料助手已卸载。')); scopeLifetime.abort(); return activityFeature?.dispose(); });
}
