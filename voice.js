import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceRuntime } from './lib/voice-runtime.js';
import { createVoiceCoordinator } from './lib/voice-coordinator.js';
import { createVoiceSession, VOICE_SESSION_ID } from './lib/voice-session.js';

export const inject = ['workfiles', 'subprocess', 'speechController', 'agents', 'agentDefaultModel', 'sessionController', 'storageDomain', 'tools', 'systemPrompt', 'commands', 'configEditor'];
export const Config = Schema.object({
  shortcut: Schema.string().default('CommandOrControl+Shift+Space').description('系统全局唤起快捷键；冲突时不会抢占别的应用。Mac 默认 ⌘⇧Space。'),
  providerId: Schema.string().default('sensevoice-local').description('已注册的语音识别器，默认本机 SenseVoice；不会自动改用云端。'),
  language: Schema.string().default('auto').description('语音识别语言提示，默认自动识别。'),
  timeoutMs: Schema.number().min(10000).max(180000).default(90000).description('每次最终录音识别及 Agent 处理的总时限（毫秒）。'),
});
// selection is an opaque provider/model/effort fingerprint, never a credential.
const IdentitySchema = z.object({ owner: z.literal('@local/deepseek-workfiles/voice'), sessionId: z.string().regex(VOICE_SESSION_ID), selection: z.string().max(200).optional() }).strict();
function selectionKey(selection) {
  const value = selection && typeof selection === 'object' ? selection : {};
  const part = item => typeof item === 'string' && item.length && item.length <= 120 ? item : '-';
  return `${part(value.provider)}/${part(value.model)}@${part(value.reasoningEffort)}`.slice(0, 200);
}
// Public DomainSpec shape, checked against rc.2 storageDomain. Identity only, never hidden model memory.
export const VoiceIdentity = Object.freeze({ name: 'local_workfiles_voice', version: 1, layout: 'single', tables: { identity: { valueSchema: IdentitySchema } } });
const CommandInput = z.object({ action: z.enum(['record', 'show', 'status', 'cancel']) }).strict();
// An ESM generation may change during a reload; resource ownership must outlive that module.
const lifecycleKey = Symbol.for('@local/deepseek-workfiles/voice/lifecycle-v1');
const lifecycleState = globalThis[lifecycleKey] ||= { disposal: Promise.resolve() };
lifecycleState.shortcutTail ||= Promise.resolve();

export async function apply(ctx, config) {
  await lifecycleState.disposal;
  const lifecycle = new AbortController();
  const timeoutMs = Math.round(config.timeoutMs);
  let domain, coordinator, session, cleanup;
  const dispose = () => {
    if (cleanup) return cleanup;
    lifecycle.abort(new Error('工作资料语音入口已卸载。'));
    cleanup = (async () => {
      try {
        await coordinator?.dispose();
        if (!coordinator) await session?.dispose();
      } finally { await domain?.close(); }
    })();
    // Config changes may reapply before Cordis awaits an async disposer; serialize the owned domain.
    lifecycleState.disposal = cleanup; cleanup.catch(() => {});
    return cleanup;
  };
  ctx.effect(() => dispose);
  try {
    if (process.platform !== 'darwin') throw new Error('此原生语音组件当前只验证了 macOS。原资料查找工具仍可使用。');
    if (typeof ctx.workfiles.status !== 'function') throw new Error('请更新工作资料助手后重新启用语音入口。');
    domain = await ctx.storageDomain.open(VoiceIdentity);
    if (lifecycle.signal.aborted) { await domain.close(); return; }
    const identity = domain.table('identity');
    const saved = identity.get('active');
    // A long-lived voice Session keeps the model it was created with. When the
    // default model/provider changes, resume would silently stay on the OLD route
    // (e.g. an exhausted OpenAI key after switching to DeepSeek), so mint a fresh
    // dedicated Session instead of reusing a stale one. A legacy record without a
    // fingerprint rotates exactly once.
    const currentSelection = selectionKey(ctx.agentDefaultModel.currentSelection());
    const reusable = saved?.sessionId && saved.selection === currentSelection ? saved.sessionId : undefined;
    const bundleRoot = path.dirname(fileURLToPath(import.meta.url));
    session = createVoiceSession({
      ctx, cwd: bundleRoot, signal: lifecycle.signal, sessionId: reusable, timeoutMs,
      activity: { bindCurrent: (token, id, signal) => ctx.workfiles.bindCurrent(token, id, signal), releaseCurrent: token => ctx.workfiles.releaseCurrent(token) },
      async onSession(sessionId) {
        lifecycle.signal.throwIfAborted();
        await identity.put('active', { owner: '@local/deepseek-workfiles/voice', sessionId, selection: currentSelection });
      },
    });
    const controller = ctx.speechController;
    coordinator = createVoiceCoordinator({
      runtime: createVoiceRuntime({ subprocess: ctx.subprocess, bundleRoot, signal: lifecycle.signal }),
      speech: {
        catalog: () => controller.catalog(), follow: signal => controller.follow(signal),
        prepare: id => controller.prepare(id), cancelPreparation: id => controller.cancelPreparation(id),
        transcribe: (request, signal) => controller.transcribe(request, signal),
      },
      session, getConfig: () => config, timeoutMs,
      getDocumentStatus: signal => ctx.workfiles.status(signal),
      captureCurrentContext: signal => ctx.workfiles.captureCurrent(signal),
      releaseCurrentContext: token => ctx.workfiles.releaseCurrent(token),
    });
    // Grant-changing controls are Human RPC only. Shortcut preflight uses real
    // native ready facts; persist only an accepted key, preserving old config on
    // conflict. A successful edit may legitimately reapply this voice entry.
    const configureShortcut = (shortcut, { signal: caller } = {}) => {
      const task = lifecycleState.shortcutTail.then(async () => {
        const workSignal = AbortSignal.any([lifecycle.signal, ...(caller ? [caller] : [])]);
        workSignal.throwIfAborted();
        const entry = ctx.fiber.entry;
        if (entry === undefined) throw new Error('当前运行方式不能保存快捷键。');
        const previous = coordinator.status().shortcut;
        try {
          const accepted = await coordinator.configureShortcut(shortcut, { signal: workSignal });
          workSignal.throwIfAborted();
          if (!accepted.registered || accepted.shortcut !== shortcut) throw new Error('这个快捷键不可用，原快捷键未更改。');
          await ctx.configEditor.edit(entry, before => {
            workSignal.throwIfAborted(); return { ...before, shortcut };
          });
          return { shortcut, persisted: true };
        } catch (error) {
          if (!lifecycle.signal.aborted && previous && coordinator.status().shortcut !== previous) {
            await coordinator.configureShortcut(previous, { signal: lifecycle.signal }).catch(() => {});
          }
          throw error;
        }
      });
      lifecycleState.shortcutTail = task.catch(() => {}); return task;
    };
    ctx.provide('workfilesVoice', { ...coordinator, configureShortcut });
    ctx.commands.register({
      name: 'workfiles-voice', definitionId: '@local/deepseek-workfiles/voice/action',
      description: '仅用户入口：唤起受控语音小窗；按需录音，说完自动处理，取消即停止后续任务。',
      input: { hint: '由语音入口按钮填写' },
      async handler({ rawInput, signal }) {
        signal.throwIfAborted();
        if (typeof rawInput !== 'string' || rawInput.length > 1000) return { kind: 'error', text: JSON.stringify({ ok: false, message: '语音操作内容无效。' }) };
        try {
          const { action } = CommandInput.parse(JSON.parse(rawInput.trim() || '{"action":"show"}'));
          let data;
          if (action === 'record' || action === 'show') data = await coordinator.open({ capture: action === 'record' });
          else if (action === 'cancel') { coordinator.cancel(); data = coordinator.status(); }
          else data = coordinator.status();
          return { kind: 'success', text: JSON.stringify({ ok: true, data }) };
        } catch (error) { return { kind: 'error', text: JSON.stringify({ ok: false, message: String(error.message || '语音入口未能启动。').slice(0, 1000) }) }; }
      },
    });
    // Startup registers the global key only. No window, microphone, model preparation or Agent prompt.
    await coordinator.start();
  } catch (error) { await dispose().catch(() => {}); throw error; }
}
