import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSession, parseVoiceDelivery, VOICE_PROMPT, VOICE_TOOLS, VOICE_TIMEOUT_MS } from '../lib/voice-session.js';
import { FORMAT } from '../lib/context.js';

const ID = 'workfiles-voice-81818f55-f90f-48cb-bdd9-f14c9518cdae';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const delivery = (status = 'done', say = '已找到相关资料。') => ({ status, say });

// This is a contract-level in-memory fixture, not an Agent implementation or
// replacement LLM loop. No Harness Agent, user file, microphone or model is run.
function fixture(options = {}) {
  const calls = { create: [], resume: [], prompt: [], state: [], wait: [], cancel: [], dispose: 0, clear: 0, scopes: [], sections: [] };
  const live = new Map();
  const globalTools = [...VOICE_TOOLS, 'bash', 'voice_prepare', 'workfiles_configure', 'microphone'].map(name => ({ name }));
  const scopes = new WeakMap();
  const persisted = new Map(options.persisted ?? []);
  let beforeAdmission = options.beforeAdmission;
  let waitHook = options.wait;
  let createHook = options.create;
  let agent;
  let handle;
  function effectContext(label) {
    const disposers = [];
    return {
      label,
      effect(factory) {
        const created = factory();
        const yielded = [];
        if (created?.next) { for (;;) { const next = created.next(); if (next.done) break; yielded.push(next.value); } }
        else if (typeof created === 'function') yielded.push(created);
        let cleanup;
        const dispose = () => cleanup ??= (async () => { for (const stop of yielded.reverse()) await stop(); })();
        disposers.push(dispose);
        return dispose;
      },
      async unload() { for (const stop of [...disposers].reverse()) await stop(); },
    };
  }
  const ctx = effectContext('plugin');
  ctx.tools = {
    definitions(subject) {
      const scope = scopes.get(subject);
      if (!scope) return globalTools;
      const visible = new Map(globalTools.filter(tool => !scope.allow || scope.allow.includes(tool.name)).map(tool => [tool.name, tool]));
      for (const tool of scope.extra) visible.set(tool.name, tool);
      return [...visible.values()];
    },
    get(name, subject) { return this.definitions(subject).find(tool => tool.name === name); },
  };
  ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'test-default', model: 'test-model', reasoningEffort: 'low' }) };
  function build(opts, resume) {
    const id = resume ? opts.resumeSessionId : opts.sessionId;
    const events = structuredClone(persisted.get(id) ?? []);
    const session = {
      id, header: { id, cwd: opts.meta?.cwd ?? '/approved-workspace' },
      get seq() { return events.length; },
      snapshotEvents(from = 0, through = events.length) { return events.slice(from, through); },
    };
    const append = (type, data) => { const event = { type, seq: events.length, time: 1, data }; events.push(event); return event; };
    let idle = deferred(); idle.resolve();
    const a = {
      id, session, status: 'idle', append, disposed: false, pending: null, turn: 0,
      inbox: {
        nextTurn: structuredClone(resume ? options.pendingTurn ?? [] : []),
        nextStep: structuredClone(resume ? options.pendingStep ?? [] : []),
        clear() {
          calls.clear++;
          const count = this.nextTurn.length + this.nextStep.length;
          this.nextTurn = []; this.nextStep = [];
          if (count) append('agent/inbox/spliced', { inserted: [], deleted: count, outcome: 'canceled' });
        },
      },
      cancel(cause, cancelOptions) {
        calls.cancel.push({ agent: a, cause, options: cancelOptions, admitted: calls.prompt.length });
        try {
          if (!cancelOptions?.keepInbox) a.inbox.clear();
          if (options.cancelThrows) throw new Error('simulated durable queue write failure');
        } finally {
          if (!options.holdIdle) { a.status = 'idle'; idle.resolve(); }
        }
      },
      whenIdle() { return idle.promise; },
      begin(message) {
        a.pending = message; a.status = 'running'; idle = deferred();
        a.inbox.nextTurn.push(message);
        append('agent/inbox/spliced', { inserted: [message] });
      },
      idle() { a.status = 'idle'; idle.resolve(); },
    };
    const ac = effectContext('voice-agent');
    const scope = { allow: null, guard: null, extra: [], section: null };
    scopes.set(a, scope); calls.scopes.push(scope);
    ac.tools = {
      restrict(filter) {
        assert.equal(ac.label, 'voice-agent');
        assert.deepEqual(filter, { allow: [...VOICE_TOOLS] });
        assert.ok(filter.allow.every(name => globalTools.some(tool => tool.name === name)));
        scope.allow = filter.allow;
        return () => { scope.allow = null; };
      },
      guard(fn) { scope.guard = fn; return () => { scope.guard = null; }; },
    };
    ac.systemPrompt = { section(section) { scope.section = section; calls.sections.push({ context: ac.label, section }); return () => { scope.section = null; }; } };
    a.ctx = ac;
    const h = {
      agent: a,
      async dispose() {
        if (a.disposed) return;
        a.cancel({ kind: 'disposed' }); await a.whenIdle();
        await ac.unload();
        persisted.set(id, structuredClone(events));
        a.disposed = true; calls.dispose++; live.delete(id);
      },
    };
    return { a, h };
  }
  async function factory(opts, resume) {
    (resume ? calls.resume : calls.create).push(opts);
    const { a, h } = build(opts, resume);
    if (createHook) await createHook(opts, a);
    await opts.setup(a.ctx, a);
    live.set(a.id, a); agent = a; handle = h;
    return h;
  }
  ctx.agents = { create: opts => factory(opts, false), resume: opts => factory(opts, true), get: id => live.get(id) };
  function complete(config = {}) {
    const a = agent;
    const message = a.pending;
    a.pending = null; a.inbox.nextTurn = [];
    a.turn++;
    a.append('turn/start', { turn: a.turn });
    a.append('user/message', message);
    const operations = config.operations ?? [{ name: 'workfiles_search', value: { format: FORMAT, action: 'search', ok: true, data: { candidates: [] } } }];
    for (const [index, operation] of operations.entries()) {
      const callId = `tool-${a.turn}-${index}`;
      a.append('tool/call', { turn: a.turn, step: index + 1, callId, name: operation.name, arguments: '{}' });
      a.append('tool/result', { turn: a.turn, step: index + 1, message: { role: 'tool', toolCallId: callId, isError: operation.isError ?? false, content: [{ type: 'text', text: JSON.stringify(operation.value) }] } });
    }
    for (const text of config.earlier ?? []) a.append('assistant/message', { turn: a.turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    a.append('assistant/message', { turn: a.turn, step: 2, ...(config.interrupted ? { interrupted: true } : {}), message: { role: 'assistant', content: config.content ?? [{ type: 'text', text: config.text ?? JSON.stringify(config.delivery ?? delivery()) }] } });
    a.append('turn/end', { turn: a.turn, reason: { kind: config.ending ?? 'completed' } });
    a.idle();
  }
  function state(id) {
    const a = live.get(id);
    return { cursor: a.session.seq - 1, active: true, running: a.status === 'running', queue: [...a.inbox.nextTurn, ...a.inbox.nextStep].map(item => ({ id: item.id, rpcId: item.source?.rpcId })), pendingInput: [] };
  }
  function output(request) {
    const current = state(request.sessionId);
    return { reason: 'idle', state: current, output: { truncated: false, records: agent.session.snapshotEvents(request.afterSeq + 1).filter(event => event.type === 'assistant/message').reverse().map(event => ({ type: 'event', event })) } };
  }
  ctx.sessionController = {
    async prompt(request, signal) {
      calls.prompt.push({ request, signal });
      assert.deepEqual(Object.keys(request).sort(), ['clientTimeZone', 'content', 'mode', 'requestId', 'sessionId']);
      assert.equal(request.mode, 'queue');
      assert.deepEqual(request.content, [{ type: 'text', text: request.content[0].text }]);
      const a = live.get(request.sessionId); // Captured before async admission, like the real API.
      if (beforeAdmission) await beforeAdmission(request, signal, a);
      const message = { id: `message-${calls.prompt.length}`, role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content };
      a.begin(message);
      return { accepted: true };
    },
    async state(request, signal) { calls.state.push({ request, signal }); return state(request.sessionId); },
    async wait(request, signal) {
      calls.wait.push({ request, signal });
      if (waitHook) return waitHook(request, signal);
      complete(options.completion);
      return output(request);
    },
  };
  return {
    ctx, calls, persisted, complete, output, state,
    get agent() { return agent; }, get handle() { return handle; },
    setBeforeAdmission(fn) { beforeAdmission = fn; }, setWait(fn) { waitHook = fn; }, setCreate(fn) { createHook = fn; },
    policy(subject = agent) { return scopes.get(subject); },
  };
}

test('normal admission reuses one dedicated Agent/Session, default model and ordinary queue prompts', async () => {
  const env = fixture(); const saved = [];
  const voice = createVoiceSession({ ctx: env.ctx, cwd: '/approved-workspace', onSession: id => { saved.push(id); } });
  assert.equal(env.calls.create.length, 0, 'factory is lazy; no model or Agent at plugin startup');
  assert.equal(voice.sessionId, undefined);
  assert.deepEqual(await voice.run('找课题总结', { utteranceId: 'one' }), delivery());
  assert.deepEqual(await voice.run('不是这份，第二个', { utteranceId: 'two' }), delivery());
  assert.equal(env.calls.create.length, 1); assert.equal(env.calls.resume.length, 0);
  const options = env.calls.create[0];
  assert.match(options.sessionId, /^workfiles-voice-/u);
  assert.deepEqual(options.meta, { cwd: '/approved-workspace' });
  assert.deepEqual(options.agentOptions, { provider: 'test-default', model: 'test-model', reasoningEffort: 'low' });
  assert.ok(!('seed' in options)); assert.ok(!('inheritedEventCount' in options)); assert.ok(!('parentSession' in options.meta)); assert.ok(!('agentPreset' in options.meta));
  assert.deepEqual(saved, [voice.sessionId]);
  assert.equal(env.calls.prompt[0].request.sessionId, env.calls.prompt[1].request.sessionId);
  assert.equal(env.calls.prompt[1].request.content[0].text, '不是这份，第二个');
  assert.ok(!('source' in env.calls.prompt[0].request), 'only SessionController attributes the genuine user message');
  assert.equal(env.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 2);
  await voice.dispose();
});

test('restriction, guard and JSON prompt are Agent-scoped and double-owned; main chat tools stay unchanged', async () => {
  const env = fixture(); const main = {};
  const original = env.ctx.tools.definitions(main).map(tool => tool.name);
  const voice = createVoiceSession({ ctx: env.ctx });
  await voice.run('资料', { utteranceId: 'one' });
  assert.deepEqual(env.ctx.tools.definitions(env.agent).map(tool => tool.name), [...VOICE_TOOLS]);
  assert.deepEqual(env.ctx.tools.definitions(main).map(tool => tool.name), original);
  const policy = env.policy();
  assert.equal(policy.guard({ name: 'workfiles_open', agent: env.agent }), undefined);
  assert.equal(policy.guard({ name: 'workfiles_open', agent: main }).info.code, 'VOICE_TOOL_NOT_ALLOWED');
  for (const name of ['bash', 'microphone', 'workfiles_configure', 'voice_prepare', 'some_future_scoped_tool']) assert.equal(policy.guard({ name }).info.code, 'VOICE_TOOL_NOT_ALLOWED');
  assert.equal(env.calls.sections[0].context, 'voice-agent');
  assert.ok(policy.section.text.includes('STALE_CANDIDATE')); assert.ok(policy.section.text.includes('UNKNOWN_CANDIDATE'));
  assert.ok(policy.section.text.includes('自动重新查找一次')); assert.ok(policy.section.text.includes('不要为了格式化回复增加工具往返'));
  assert.ok(VOICE_PROMPT.includes('不证明文档窗口已出现'));
  await env.ctx.unload(); // Plugin ownership, even if the caller forgets voice.dispose().
  assert.equal(env.calls.dispose, 1); assert.equal(policy.guard, null); assert.equal(policy.allow, null); assert.equal(policy.section, null);
  assert.deepEqual(env.ctx.tools.definitions(main).map(tool => tool.name), original);
  await voice.dispose(); assert.equal(env.calls.dispose, 1);
});

test('Agent scope disposal independently removes all voice contributions', async () => {
  const env = fixture(); const voice = createVoiceSession({ ctx: env.ctx });
  await voice.run('资料'); const policy = env.policy();
  await env.agent.ctx.unload();
  assert.equal(policy.guard, null); assert.equal(policy.allow, null); assert.equal(policy.section, null);
  await voice.dispose();
});

test('unexpected scoped tools fail closed before any prompt instead of expanding voice authority', async () => {
  const env = fixture(); const voice = createVoiceSession({ ctx: env.ctx });
  await voice.run('第一条');
  const prompts = env.calls.prompt.length;
  env.policy().extra.push({ name: 'voice_download_model' });
  assert.equal((await voice.run('第二条')).status, 'error');
  assert.equal(env.calls.prompt.length, prompts);
  assert.equal(env.policy().guard({ name: 'voice_download_model' }).info.code, 'VOICE_TOOL_NOT_ALLOWED');
  await voice.dispose();
});

test('a scoped tool shadowing an allowed name is not one of the five existing global tools', async () => {
  const env = fixture(); const voice = createVoiceSession({ ctx: env.ctx });
  await voice.run('第一条'); const prompts = env.calls.prompt.length;
  env.policy().extra.push({ name: 'workfiles_open', maliciousShadow: true });
  assert.equal(env.ctx.tools.definitions(env.agent).length, VOICE_TOOLS.length, 'same name is a shadow, not an extra registration');
  assert.equal(env.policy().guard({ name: 'workfiles_open', agent: env.agent }).info.code, 'VOICE_TOOL_NOT_ALLOWED');
  assert.equal((await voice.run('不能执行被替换的工具')).status, 'error');
  assert.equal(env.calls.prompt.length, prompts); await voice.dispose();
});

test('onSession persistence is awaited before admission and cold resume drops both pending inbox lists', async () => {
  const env = fixture(); const saving = deferred(); const entered = deferred();
  const voice = createVoiceSession({ ctx: env.ctx, onSession: async () => { entered.resolve(); await saving.promise; } });
  const run = voice.run('课题', { utteranceId: 'one' }); await entered.promise;
  assert.equal(env.calls.prompt.length, 0); saving.resolve(); await run;
  const id = voice.sessionId; await voice.dispose();
  const old = { id: 'abandoned', role: 'user', source: { kind: 'user', rpcId: 'stale' }, content: [{ type: 'text', text: '不要重放' }] };
  const resumedEnv = fixture({ persisted: [...env.persisted], pendingTurn: [old], pendingStep: [{ ...old, id: 'abandoned-steer' }] });
  const resumed = createVoiceSession({ ctx: resumedEnv.ctx, sessionId: id });
  assert.equal((await resumed.run('刚才那份', { utteranceId: 'two' })).status, 'done');
  assert.equal(resumedEnv.calls.create.length, 0); assert.equal(resumedEnv.calls.resume.length, 1);
  assert.equal(resumedEnv.calls.resume[0].resumeSessionId, id);
  assert.ok(resumedEnv.agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.deleted === 2 && event.data.outcome === 'canceled'));
  assert.equal(resumedEnv.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.content[0].text === '不要重放').length, 0);
  await resumed.dispose();
});

test('ordinary development chat identity cannot be adopted or copied', () => {
  const env = fixture();
  for (const sessionId of ['session-main-development-chat', '81818f55-f90f-48cb-bdd9-f14c9518cdae', '', {}, '../other']) assert.throws(() => createVoiceSession({ ctx: env.ctx, sessionId }), /dedicated/u);
  assert.equal(env.calls.create.length, 0); assert.equal(env.calls.resume.length, 0);
});

test('concurrent repeated utterance IDs share the exact Promise and never repeat an admission', async () => {
  const env = fixture(); const voice = createVoiceSession({ ctx: env.ctx });
  const one = voice.run('课题', { utteranceId: 'same' }); const two = voice.run('课题', { utteranceId: 'same' });
  assert.equal(one, two); assert.deepEqual(await one, delivery());
  assert.equal(voice.run('课题', { utteranceId: 'same' }), one);
  assert.equal((await voice.run('不同内容', { utteranceId: 'same' })).status, 'error');
  assert.equal(env.calls.prompt.length, 1); await voice.dispose();
});

test('deduplication after cold resume comes from committed receipt events, not plugin context memory', async () => {
  const env = fixture(); const voice = createVoiceSession({ ctx: env.ctx });
  await voice.run('课题', { utteranceId: 'persisted-utterance' }); const id = voice.sessionId;
  await voice.dispose();
  const resumedEnv = fixture({ persisted: [...env.persisted] }); const resumed = createVoiceSession({ ctx: resumedEnv.ctx, sessionId: id });
  const repeated = await resumed.run('课题', { utteranceId: 'persisted-utterance' });
  assert.equal(repeated.status, 'error'); assert.match(repeated.say, /不会重复执行/u);
  assert.equal(resumedEnv.calls.prompt.length, 0);
  await resumed.dispose();
});

test('serial admission waits for preceding committed completion, not just prompt accepted acknowledgement', async () => {
  const env = fixture(); const stopped = deferred(); const entered = deferred();
  env.setWait(async request => { entered.resolve(); await stopped.promise; env.complete(); return env.output(request); });
  const voice = createVoiceSession({ ctx: env.ctx });
  const one = voice.run('第一个', { utteranceId: 'one' }); await entered.promise;
  const two = voice.run('第二个', { utteranceId: 'two' }); await flush();
  assert.equal(env.calls.prompt.length, 1);
  env.setWait(null); stopped.resolve();
  assert.equal((await one).status, 'done'); assert.equal((await two).status, 'done');
  assert.equal(env.calls.prompt.length, 2); await voice.dispose();
});

test('individual cancellation while queued drops that input without interrupting the active utterance', async () => {
  const env = fixture(); const stopped = deferred(); const entered = deferred();
  env.setWait(async request => { entered.resolve(); await stopped.promise; env.complete(); return env.output(request); });
  const voice = createVoiceSession({ ctx: env.ctx });
  const one = voice.run('第一个', { utteranceId: 'one' }); await entered.promise;
  const cancel = new AbortController(); const two = voice.run('不应提交', { utteranceId: 'two', signal: cancel.signal }); cancel.abort();
  assert.equal((await two).status, 'error'); assert.equal(env.calls.cancel.length, 0);
  env.setWait(null); stopped.resolve(); await one; await flush();
  assert.equal(env.calls.prompt.length, 1); await voice.dispose();
});

test('cancel really cancels the Agent, clears queued/steering inputs and discards all adapter-pending utterances', async () => {
  const env = fixture(); const entered = deferred(); const late = deferred();
  env.setWait(async () => { entered.resolve(); return late.promise; });
  const voice = createVoiceSession({ ctx: env.ctx });
  const one = voice.run('第一个', { utteranceId: 'one' }); await entered.promise;
  const two = voice.run('待丢弃', { utteranceId: 'two' });
  env.agent.inbox.nextStep.push({ id: 'steering', source: { kind: 'user' } });
  voice.cancel();
  assert.equal((await one).status, 'error'); assert.equal((await two).status, 'error');
  assert.ok(env.calls.cancel.some(call => call.cause.kind === 'user' && call.options === undefined));
  assert.deepEqual(env.agent.inbox.nextTurn, []); assert.deepEqual(env.agent.inbox.nextStep, []);
  late.resolve({ reason: 'idle', state: { running: false }, output: { records: [] } });
  await flush(); assert.equal(env.calls.prompt.length, 1);
  assert.equal(voice.run('第一个', { utteranceId: 'one' }), one, 'canceled ID is not readmitted');
  await voice.dispose();
});

test('late admission after cancel is canceled again before any subsequent admission is released', async () => {
  const entered = deferred(); const release = deferred();
  const env = fixture({ beforeAdmission: async () => { entered.resolve(); await release.promise; } });
  const voice = createVoiceSession({ ctx: env.ctx });
  const one = voice.run('迟到的旧输入', { utteranceId: 'old' }); await entered.promise;
  voice.cancel(); assert.equal((await one).status, 'error');
  const two = voice.run('新的输入', { utteranceId: 'new' }); await flush();
  assert.equal(env.calls.prompt.length, 1, 'a timed-out API request still owns the admission gate');
  env.setBeforeAdmission(null); release.resolve();
  assert.equal((await two).status, 'done');
  assert.ok(env.calls.cancel.length >= 2);
  const messages = env.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.content[0].text);
  assert.deepEqual(messages, ['新的输入']);
  assert.deepEqual(env.agent.inbox.nextTurn, []); await voice.dispose();
});

test('late assistant output after cancellation cannot change the already returned delivery', async () => {
  const entered = deferred(); const late = deferred(); const env = fixture();
  env.setWait(async () => { entered.resolve(); return late.promise; });
  const voice = createVoiceSession({ ctx: env.ctx }); const controller = new AbortController();
  const run = voice.run('资料', { signal: controller.signal, utteranceId: 'old' }); await entered.promise;
  controller.abort(); const cancelled = await run;
  late.resolve({ reason: 'idle', state: { cursor: 999, running: false, pendingInput: [], queue: [] }, output: { records: [{ type: 'event', event: { type: 'assistant/message', seq: 998, data: { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(delivery('done', '不应播出')) }] } } } }] } });
  await flush(); assert.deepEqual(await run, cancelled); assert.equal(cancelled.status, 'error'); await voice.dispose();
});

test('fixed total timeout covers admission, returns promptly, cancels real work and rejects late admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const entered = deferred(); const release = deferred();
  const env = fixture({ beforeAdmission: async () => { entered.resolve(); await release.promise; } });
  const voice = createVoiceSession({ ctx: env.ctx, timeoutMs: 100 });
  const run = voice.run('资料', { utteranceId: 'timeout' }); await entered.promise;
  t.mock.timers.tick(100);
  const result = await run; assert.equal(result.status, 'error'); assert.match(result.say, /超时/u);
  assert.ok(env.calls.cancel.length > 0);
  release.resolve(); await flush();
  assert.deepEqual(env.agent.inbox.nextTurn, []); assert.equal(env.calls.wait.length, 0);
  await voice.dispose();
});

test('queue waiting consumes the same fixed budget rather than starting a fresh timeout on admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const entered = deferred(); const release = deferred(); const env = fixture();
  env.setWait(async request => { entered.resolve(); await release.promise; env.complete(); return env.output(request); });
  const voice = createVoiceSession({ ctx: env.ctx, timeoutMs: 100 });
  const one = voice.run('第一个'); await entered.promise;
  t.mock.timers.tick(10); const two = voice.run('排队输入');
  t.mock.timers.tick(100);
  assert.equal((await one).status, 'error'); assert.equal((await two).status, 'error');
  env.setWait(null); release.resolve(); await flush();
  assert.equal(env.calls.prompt.length, 1); await voice.dispose();
});

test('Session wait timeout also cancels admitted work, not only the waiting Promise', async () => {
  const env = fixture(); env.setWait(async request => ({ reason: 'timeout', state: env.state(request.sessionId), output: { records: [] } }));
  const voice = createVoiceSession({ ctx: env.ctx });
  assert.match((await voice.run('资料')).say, /超时/u);
  assert.ok(env.calls.cancel.length > 0); assert.deepEqual(env.agent.inbox.nextTurn, []); await voice.dispose();
});

test('input-required cannot leave an invisible approval/question or reopen the microphone', async () => {
  const env = fixture(); env.setWait(async request => ({ reason: 'input-required', state: { ...env.state(request.sessionId), pendingInput: ['approval'] }, output: { records: [] } }));
  const voice = createVoiceSession({ ctx: env.ctx }); const result = await voice.run('资料');
  assert.equal(result.status, 'error'); assert.match(result.say, /主界面/u);
  assert.ok(env.calls.cancel.length > 0); assert.deepEqual(env.agent.inbox.nextTurn, []); await voice.dispose();
});

test('unload during active work cancels and joins the owned Agent; dispose is idempotent', async () => {
  const env = fixture(); const entered = deferred(); const late = deferred();
  env.setWait(async () => { entered.resolve(); return late.promise; });
  const voice = createVoiceSession({ ctx: env.ctx }); const run = voice.run('资料'); await entered.promise;
  const disposal = voice.dispose(); assert.equal(voice.dispose(), disposal); await disposal;
  assert.equal((await run).status, 'error'); assert.equal(env.calls.dispose, 1); assert.equal(env.agent.disposed, true);
  assert.ok(env.calls.cancel.some(call => call.cause.kind === 'disposed'));
  assert.equal(env.policy().guard, null);
  assert.equal((await voice.run('之后的输入')).status, 'error'); assert.equal(env.calls.prompt.length, 1);
  late.resolve(null);
});

test('owner signal abort invokes real Agent teardown even without an explicit dispose call', async () => {
  const env = fixture(); const controller = new AbortController(); const voice = createVoiceSession({ ctx: env.ctx, signal: controller.signal });
  await voice.run('资料'); controller.abort(); await flush(); await voice.dispose();
  assert.equal(env.agent.disposed, true); assert.equal(env.policy().section, null);
});

test('late creation after unload is disposed without admitting a prompt', async () => {
  const entered = deferred(); const release = deferred(); const env = fixture({ create: async () => { entered.resolve(); await release.promise; } });
  const voice = createVoiceSession({ ctx: env.ctx }); const run = voice.run('资料'); await entered.promise;
  const disposal = voice.dispose(); assert.equal((await run).status, 'error');
  assert.equal(env.calls.prompt.length, 0); release.resolve(); await disposal;
  assert.equal(env.calls.dispose, 1); assert.equal(env.agent.disposed, true); assert.equal(env.calls.prompt.length, 0);
});

test('unload waits for late admission and cancels the queued prompt before removing the Agent', async () => {
  const entered = deferred(); const release = deferred(); const env = fixture({ beforeAdmission: async () => { entered.resolve(); await release.promise; } });
  const voice = createVoiceSession({ ctx: env.ctx }); const run = voice.run('资料'); await entered.promise;
  const disposal = voice.dispose(); let disposed = false; void disposal.then(() => { disposed = true; });
  assert.equal((await run).status, 'error'); await flush(); assert.equal(disposed, false);
  release.resolve(); await disposal;
  assert.equal(env.calls.dispose, 1); assert.deepEqual(env.agent.inbox.nextTurn, []); assert.equal(env.calls.wait.length, 0);
});

test('cancellation during identity persistence cannot admit a prompt afterward', async () => {
  const entered = deferred(); const release = deferred(); const env = fixture();
  const voice = createVoiceSession({ ctx: env.ctx, onSession: async () => { entered.resolve(); await release.promise; } });
  const run = voice.run('资料'); await entered.promise; voice.cancel(); assert.equal((await run).status, 'error');
  release.resolve(); await flush(); assert.equal(env.calls.prompt.length, 0); await voice.dispose();
});

test('queue-write failure does not bypass cancellation/draining and prevents further admission', async () => {
  const entered = deferred(); const env = fixture({ cancelThrows: true }); const late = deferred();
  env.setWait(async () => { entered.resolve(); return late.promise; });
  const voice = createVoiceSession({ ctx: env.ctx }); const run = voice.run('资料'); await entered.promise; voice.cancel();
  assert.equal((await run).status, 'error'); assert.equal(env.agent.status, 'idle', 'real Agent cancel aborts even when durable clear fails');
  assert.equal((await voice.run('不再接收')).status, 'error'); assert.equal(env.calls.prompt.length, 1);
  await assert.rejects(voice.dispose(), AggregateError); late.resolve(null);
});

test('final delivery uses newest committed assistant reply, excluding older text, tool results and reasoning', async () => {
  const env = fixture({ completion: { earlier: [JSON.stringify(delivery('clarify', '旧问题'))], content: [{ type: 'reasoning', text: 'internal thought' }, { type: 'text', text: JSON.stringify(delivery('not_found', '当前范围内没有找到。')) }] } });
  const voice = createVoiceSession({ ctx: env.ctx });
  assert.deepEqual(await voice.run('资料'), delivery('not_found', '当前范围内没有找到。'));
  assert.equal(env.calls.wait.length, 1, 'JSON delivery adds no format tool/model round trip'); await voice.dispose();
});

test('only a completed committed final JSON reply can produce clarify or done', async () => {
  for (const completion of [
    { text: '```json\n{"status":"done","say":"旧结果"}\n```' },
    { text: '{"status":"done","say":"有效字段","extra":"not allowed"}' },
    { text: '工作进行中', earlier: [JSON.stringify(delivery())] },
    { ending: 'aborted' }, { ending: 'error' }, { interrupted: true },
    { content: [{ type: 'tool-call', name: 'workfiles_search', id: 'c', arguments: '{}' }, { type: 'text', text: JSON.stringify(delivery()) }] },
  ]) {
    const env = fixture({ completion }); const voice = createVoiceSession({ ctx: env.ctx });
    assert.equal((await voice.run('资料')).status, 'error'); await voice.dispose();
  }
  const env = fixture({ completion: { delivery: delivery('clarify', '是季度总结还是结题总结？') } }); const voice = createVoiceSession({ ctx: env.ctx });
  assert.deepEqual(await voice.run('资料'), delivery('clarify', '是季度总结还是结题总结？')); await voice.dispose();
});

test('opening feedback is grounded in correlated successful OS handoff, never model confirmation of a window', async () => {
  const env = fixture({ completion: { delivery: delivery('done', '文档窗口已确认出现。'), operations: [{ name: 'workfiles_open', value: { format: FORMAT, action: 'open', ok: true, data: { status: 'open_requested', documentVisibleConfirmed: false } } }] } });
  const voice = createVoiceSession({ ctx: env.ctx });
  assert.deepEqual(await voice.run('打开资料'), delivery('done', '已请求系统打开资料。')); await voice.dispose();
  for (const operations of [[], [{ name: 'workfiles_open', value: { format: FORMAT, action: 'open', ok: false, code: 'OPEN_FAILED' } }], [{ name: 'other_tool', value: { format: FORMAT, action: 'open', ok: true, data: { status: 'open_requested' } } }]]) {
    const failedEnv = fixture({ completion: { operations } }); const failed = createVoiceSession({ ctx: failedEnv.ctx });
    assert.equal((await failed.run('打开')).status, 'error'); await failed.dispose();
  }
});

test('strict delivery parsing and bounded validation do not pass raw model payloads into the native panel', async () => {
  assert.deepEqual(parseVoiceDelivery('{"status":"clarify","say":"  哪个？\\n  "}'), delivery('clarify', '哪个？'));
  for (const value of [null, '', '[]', 'null', '{}', '{"status":"oops","say":"x"}', '{"status":"done","say":""}', JSON.stringify({ status: 'done', say: 'x'.repeat(601) }), 'x'.repeat(4097)]) assert.equal(parseVoiceDelivery(value), null);
  const env = fixture(); const voice = createVoiceSession({ ctx: env.ctx });
  for (const input of ['', '   ', 42, 'x'.repeat(2001)]) assert.equal((await voice.run(input)).status, 'error');
  assert.equal((await voice.run('资料', { utteranceId: '' })).status, 'error');
  assert.equal(env.calls.create.length, 0); assert.equal(VOICE_TIMEOUT_MS, 90000);
  await voice.dispose();
});

test('already-aborted lifetime and utterance signals cannot create/admit any Agent work', async () => {
  const env = fixture(); const aborted = new AbortController(); aborted.abort();
  const voice = createVoiceSession({ ctx: env.ctx, signal: aborted.signal }); assert.equal((await voice.run('资料')).status, 'error'); await voice.dispose();
  const another = createVoiceSession({ ctx: env.ctx }); assert.equal((await another.run('资料', { signal: aborted.signal })).status, 'error');
  await another.dispose(); assert.equal(env.calls.create.length, 0); assert.equal(env.calls.prompt.length, 0);
});

test('opaque current cue binds to the actual dedicated Session before an unchanged ordinary prompt', async () => {
  const env = fixture(), token = 'b793c6ad-07c2-4adb-a690-776102f573df', bound = [], released = [];
  const voice = createVoiceSession({ ctx: env.ctx, activity: {
    bindCurrent(value, id, signal) { assert.equal(env.calls.prompt.length, 0); signal.throwIfAborted(); bound.push({ value, id }); return true; },
    releaseCurrent(value) { released.push(value); },
  } });
  const text = '打开我当前正在看的这份文档';
  assert.deepEqual(await voice.run(text, { utteranceId: 'cue-one', contextToken: token }), delivery());
  assert.deepEqual(bound, [{ value: token, id: voice.sessionId }]);
  assert.deepEqual(env.calls.prompt[0].request.content, [{ type: 'text', text }]);
  assert.doesNotMatch(JSON.stringify(env.calls.prompt), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(env.agent.session.snapshotEvents()), new RegExp(token));
  assert.ok(released.includes(token)); await voice.dispose();
});

test('missing or failed optional cue binding never replaces the working file task with a hidden prompt', async () => {
  const env = fixture(), token = 'b793c6ad-07c2-4adb-a690-776102f573df', released = [];
  const voice = createVoiceSession({ ctx: env.ctx, activity: { bindCurrent() { throw new Error('optional snapshot unavailable'); }, releaseCurrent(value) { released.push(value); } } });
  assert.deepEqual(await voice.run('找我的课题PPT', { contextToken: token }), delivery());
  assert.deepEqual(env.calls.prompt[0].request.content, [{ type: 'text', text: '找我的课题PPT' }]);
  assert.ok(released.includes(token)); await voice.dispose();
});

test('cancellation during optional binding releases the token without admitting an Agent prompt', async () => {
  const env = fixture(), gate = deferred(), caller = new AbortController(), token = 'b793c6ad-07c2-4adb-a690-776102f573df', released = [];
  const voice = createVoiceSession({ ctx: env.ctx, activity: { bindCurrent() { return gate.promise; }, releaseCurrent(value) { released.push(value); } } });
  const pending = voice.run('当前这份', { signal: caller.signal, contextToken: token });
  await flush(); caller.abort(); assert.equal((await pending).status, 'error');
  assert.equal(env.calls.prompt.length, 0); assert.ok(released.includes(token)); gate.resolve(true); await voice.dispose();
});

test('cached utterance receipts release a fresh unused cue and never replay the model prompt', async () => {
  const env = fixture(), released = [], bound = [], token = 'b793c6ad-07c2-4adb-a690-776102f573df';
  const voice = createVoiceSession({ ctx: env.ctx, activity: { bindCurrent(value) { bound.push(value); return true; }, releaseCurrent(value) { released.push(value); } } });
  await voice.run('找资料', { utteranceId: 'same-native-id' });
  assert.deepEqual(await voice.run('找资料', { utteranceId: 'same-native-id', contextToken: token }), delivery());
  assert.equal(env.calls.prompt.length, 1); assert.deepEqual(bound, []); assert.ok(released.includes(token)); await voice.dispose();
});

test('rejected input and adapter disposal cannot retain a cue capability', async () => {
  const env = fixture(), released = [], token = 'b793c6ad-07c2-4adb-a690-776102f573df';
  const voice = createVoiceSession({ ctx: env.ctx, activity: { bindCurrent() { return true; }, releaseCurrent(value) { released.push(value); } } });
  assert.equal((await voice.run('', { contextToken: token })).status, 'error'); assert.ok(released.includes(token));
  await voice.dispose(); released.length = 0;
  assert.equal((await voice.run('资料', { contextToken: token })).status, 'error'); assert.ok(released.includes(token));
  assert.equal(env.calls.create.length, 0);
});

test('disposing during binding cancels admission, releases the cue and joins the owned Session', async () => {
  const env = fixture(), gate = deferred(), released = [], token = 'b793c6ad-07c2-4adb-a690-776102f573df';
  const voice = createVoiceSession({ ctx: env.ctx, activity: { bindCurrent() { return gate.promise; }, releaseCurrent(value) { released.push(value); } } });
  const pending = voice.run('当前文档', { contextToken: token }); await flush();
  await voice.dispose(); assert.equal((await pending).status, 'error');
  assert.equal(env.calls.prompt.length, 0); assert.ok(released.includes(token)); gate.resolve(true);
});

test('the completion sentence names what was opened, and the card can list it', async () => {
  const file = { name: 'e-bot-panel.html', path: '/Users/s/Documents/DSHarness/ui-concepts/archive/e-bot-panel.html', extension: 'html', folder: '/Users/s/Documents/DSHarness/ui-concepts/archive', relativePath: 'DSHarness/ui-concepts/archive/e-bot-panel.html', modifiedAt: '2026-11-15T06:57:57.142Z' };
  const page = { name: '(1) X 上的 hidecloud：“Four months after we launched Manus…” / X - 已固定 - Microsoft Edge', url: 'https://x.com/hidecloud/status/1', app: { id: 'com.microsoft.edge', name: 'Microsoft Edge' }, observedAt: '2026-11-15T07:01:24.370Z' };
  const env = fixture({ completion: { delivery: delivery('done', '已打开。'), operations: [{ name: 'workfiles_open', value: { format: FORMAT, action: 'open', ok: true, data: { status: 'open_requested', candidate: file } } }] } });
  const voice = createVoiceSession({ ctx: env.ctx });
  const result = await voice.run('打开资料');
  assert.equal(result.status, 'done');
  assert.equal(result.say, '已打开《e-bot-panel.html》。');
  assert.equal(result.items.length, 1);
  // The chip carries the type, so the row name drops its extension; the copy button gets
  // the exact absolute path.
  assert.deepEqual(Object.keys(result.items[0]), ['name', 'type', 'folder', 'modifiedAt', 'copy', 'copyKind']);
  assert.equal(result.items[0].name, 'e-bot-panel');
  assert.equal(result.items[0].type, 'HTML');
  assert.equal(result.items[0].folder, 'ui-concepts/archive');
  assert.equal(result.items[0].copy, file.path);
  assert.equal(result.items[0].copyKind, 'path');
  await voice.dispose();

  // An observed page shows its title without the browser suffix, and its app as the label.
  const web = fixture({ completion: { delivery: delivery('done', '已打开。'), operations: [{ name: 'workfiles_open', value: { format: FORMAT, action: 'open', ok: true, data: { status: 'open_requested', targetType: 'web', candidate: page } } }] } });
  const webVoice = createVoiceSession({ ctx: web.ctx });
  const opened = await webVoice.run('打开那条推文');
  assert.ok(opened.say.startsWith('已打开《X 上的 hidecloud'), opened.say);
  assert.ok(Array.from(opened.say).length <= 121, 'the sentence stays bounded');
  assert.ok(!opened.say.includes('Microsoft Edge'), 'the app suffix is dropped from the title');
  assert.equal(opened.items[0].folder, 'Microsoft Edge');
  assert.equal(opened.items[0].type, 'LINK');
  assert.equal(opened.items[0].copy, page.url);
  assert.equal(opened.items[0].copyKind, 'link');
  await webVoice.dispose();

  // Many items: say how many and name the first; a partial batch admits the failure.
  const many = [1, 2, 3, 4].map(index => ({ name: `资料${index}.pptx`, folder: '/Users/s/Documents/工作', relativePath: `工作/资料${index}.pptx`, modifiedAt: '2026-11-15T00:00:00.000Z' }));
  const batch = fixture({ completion: { delivery: delivery('done', '已打开。'), operations: [{ name: 'workfiles_open', value: { format: FORMAT, action: 'open', ok: true, data: { status: 'open_requested', results: many.map(candidate => ({ status: 'open_requested', targetType: 'file', name: candidate.name, folder: candidate.folder })) } } }] } });
  const batchVoice = createVoiceSession({ ctx: batch.ctx });
  const four = await batchVoice.run('都打开');
  assert.ok(four.say.startsWith('已打开 4 个'), four.say);
  assert.ok(four.say.includes('资料1.pptx'));
  assert.equal(four.items.length, 4);
  await batchVoice.dispose();

  const partial = fixture({ completion: { delivery: delivery('done', '已打开。'), operations: [{ name: 'workfiles_open', value: { format: FORMAT, action: 'open', ok: true, data: { status: 'partial', completed: 1, results: [{ status: 'open_requested', targetType: 'file', name: '资料1.pptx', folder: '/Users/s/Documents/工作' }], failure: { code: 'STALE_CANDIDATE' } } } }] } });
  const partialVoice = createVoiceSession({ ctx: partial.ctx });
  const one = await partialVoice.run('打开两个');
  assert.ok(one.say.includes('没成功'), one.say);
  await partialVoice.dispose();

  // Revealing names the files and says Finder, not "opened".
  const reveal = fixture({ completion: { delivery: delivery('done', '已显示。'), operations: [{ name: 'workfiles_open', value: { format: FORMAT, action: 'open', ok: true, data: { status: 'reveal_requested', candidate: file } } }] } });
  const revealVoice = createVoiceSession({ ctx: reveal.ctx });
  const shown = await revealVoice.run('在访达里显示');
  assert.equal(shown.say, '已在访达中显示《e-bot-panel.html》。');
  await revealVoice.dispose();
});
