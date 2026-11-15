import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SaxesParser } from 'saxes';
import { apply, inject, Config } from '../index.js';
import { apply as applyVoice, inject as voiceInject, VoiceIdentity } from '../voice.js';
import { createToolDefinitions, WORKFILES_PROMPT } from '../lib/tools.js';
const root = fileURLToPath(new URL('../', import.meta.url));

test('a linked Host entry imports without a separately installed Harness runtime', () => {
  assert.equal(typeof apply, 'function'); assert.ok(Config);
  assert.ok(inject.includes('fs')); assert.ok(inject.includes('sessionProjections'));
});
test('local distribution includes every runtime entry and localized original artwork', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  for (const entry of manifest.files) assert.ok((await fs.stat(path.join(root, entry))).isFile() || (await fs.stat(path.join(root, entry))).isDirectory(), entry);
  for (const entry of ['.', './voice', './client', './icon', './voice/icon']) {
    const resource = path.resolve(root, manifest.exports[entry]);
    assert.equal(path.dirname(resource), path.resolve(root)); assert.ok((await fs.stat(resource)).size > 0);
  }
  assert.equal(manifest.engines.dsh, '0.2.2-rc.3');
  assert.equal(manifest.version, '0.9.0');
  assert.equal(typeof applyVoice, 'function');
  for (const key of ['workfiles', 'agents', 'agentDefaultModel', 'sessionController', 'speechController', 'storageDomain', 'subprocess']) assert.ok(voiceInject.includes(key), key);
  // rc.2 public storage unit names are SQL/file-safe identifier segments, not package names.
  assert.match(VoiceIdentity.name, /^[a-z][a-z0-9_]*$/u);
  assert.equal(VoiceIdentity.layout, 'single');
  assert.deepEqual(Object.keys(VoiceIdentity.tables), ['identity']);
  for (const resource of ['voice.js', 'native', 'voice-ui', 'VOICE_PROTOCOL.md']) assert.ok(manifest.files.includes(resource));
  assert.ok(!manifest.files.includes('.native'), 'Machine-owned runtime copies are not portable package contents');
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts[lifecycle], undefined);
  for (const language of ['zh', 'en']) {
    const value = JSON.parse(await fs.readFile(path.join(root, 'locale', `${language}.json`), 'utf8'));
    assert.ok(value.meta.title.length > 2); assert.ok(value.meta.description.length > 20);
    assert.ok(!value.meta.title.includes('decoration'));
  }
  const svg = await fs.readFile(path.join(root, manifest.exports['./icon']));
  assert.ok(svg.length < 256 * 1024);
  const tags = []; const parser = new SaxesParser({ xmlns: true });
  parser.on('error', error => { throw error; }); parser.on('doctype', () => { throw new Error('Icon must not contain a DTD'); });
  parser.on('opentag', tag => { tags.push(tag.local); assert.ok(!['script', 'foreignObject', 'image'].includes(tag.local)); });
  parser.write(svg.toString('utf8')).close(); assert.equal(tags[0], 'svg');
});
test('voice model rotation: a long-lived voice Session must not stay on a stale provider/model', async () => {
  const voiceSource = await fs.readFile(path.join(root, 'voice.js'), 'utf8');
  // Identity gains an opaque selection fingerprint, never a credential.
  assert.match(voiceSource, /selection: z\.string\(\)\.max\(200\)\.optional\(\)/u);
  // Only an identical fingerprint may resume the saved dedicated Session.
  assert.match(voiceSource, /const reusable = saved\?\.sessionId && saved\.selection === currentSelection \? saved\.sessionId : undefined;/u);
  assert.match(voiceSource, /sessionId: reusable/u);
  assert.match(voiceSource, /selection: currentSelection/u);
  const key = voiceSource.slice(voiceSource.indexOf('function selectionKey'), voiceSource.indexOf('export const inject'));
  assert.doesNotMatch(key, /apiKey|token|secret|authorization/iu);
});

test('native definitions validate arguments with Zod before invoking an operation', async () => {
  let calls = 0; const tools = createToolDefinitions(async (_exec, action, args) => { calls++; return { action, args }; });
  const open = tools.find(value => value.name === 'workfiles_open');
  await assert.rejects(open.execute({ candidateId: '/arbitrary/document.pptx' }, {}), { code: 'INVALID_ARGS' });
  await assert.rejects(open.execute({ candidateId: 'wf-00000000-0000-4000-8000-000000000000', roots: ['/'] }, {}), { code: 'INVALID_ARGS' });
  const search = tools.find(value => value.name === 'workfiles_search');
  await assert.rejects(search.execute({ limit: 21 }, {}), { code: 'INVALID_ARGS' });
  assert.equal(calls, 0);
  const value = await search.execute({ query: '课题', content: false }, {});
  assert.equal(value.args.content, false); assert.equal(calls, 1);
  assert.equal(open.parameters.additionalProperties, false); assert.deepEqual(open.parameters.required, ['candidateId']);
});
test('Client mounts the global Human surface before nested namespace injection and owns locale cleanup', async () => {
  const source = await fs.readFile(path.join(root, 'client.js'), 'utf8');
  const declared = [...source.match(/\binject:\s*\[([^\]]+)\]/u)[1].matchAll(/'([^']+)'/gu)].map(match => match[1]);
  for (const dependency of ['slots', 'locale', 'remote', 'uiWorkspace']) assert.ok(declared.includes(dependency), dependency);
  assert.ok(!declared.includes('remote.workfilesActivity'), 'the namespace is not available until mount, so it must not block root setup');
  assert.match(source, /ctx\.effect\(\(\) => locale\.register\(namespace, dictionaries\)\)/u);
  assert.match(source, /const namespace = 'local-workfiles-v0-3-0'/u);
  assert.ok(source.indexOf('await ctx.remote.$mount(') < source.indexOf("ctx.inject(['remote.workfilesActivity']"));
});

test('Client decodes strict Activity RemoteResult envelopes without a Session/CommandExecution wrapper', async () => {
  const source = await fs.readFile(path.join(root, 'client.js'), 'utf8');
  const body = source.slice(source.indexOf('// BEGIN_WORKFILES_PURE'), source.indexOf('// END_WORKFILES_PURE'));
  assert.ok(body.length > 0);
  const decode = Function(`"use strict"; ${body}\nreturn decodeActivityResponse;`)();
  const wrapped = value => ({ ok: true, value: { ok: true, data: value } });
  assert.deepEqual(decode(wrapped({ roots: ['/chosen'], enabled: true }), 'fallback').roots, ['/chosen']);
  assert.equal(decode(wrapped({ registered: true }), 'fallback').registered, true);
  assert.throws(() => decode({ ok: false, error: { message: 'Permission denied', code: 'FORBIDDEN' } }, 'fallback'), /Permission denied/u);
  assert.throws(() => decode({ ok: false, error: { code: 'REMOTE_DISCONNECTED' } }, 'fallback'), /REMOTE_DISCONNECTED/u);
  for (const response of [undefined, { ok: true }, { ok: true, value: undefined }, { ok: true, value: { result: { kind: 'success', text: '{"ok":true}' } } }, { ok: true, value: { ok: true, data: null, foreign: true } }]) assert.throws(() => decode(response, 'fallback'));
  const request = source.slice(source.indexOf('async function request('), source.indexOf('function useLocale('));
  assert.ok(request.indexOf('signal.throwIfAborted()') < request.indexOf('return decodeActivityResponse('));
  assert.doesNotMatch(request, /activeSession|requestSession|sessionController|commands\.execute/u);
});

test('Client preserves atomic voice/settings controls and has a Session-independent sidebar entry', async () => {
  const source = await fs.readFile(path.join(root, 'client.js'), 'utf8');
  const top = source.slice(source.indexOf("h('div', { className: 'wf-top' }"), source.indexOf("operation.error ? h('p'"));
  assert.ok(top.indexOf("className: 'wf-start'") < top.indexOf("className: 'wf-settings'"));
  assert.ok(top.indexOf("className: 'wf-settings'") < top.indexOf("className: 'wf-key'"));
  assert.ok(!source.includes('margin-left:auto'));
  assert.match(source, /\.wf-controls\{[^}]*flex-wrap:nowrap;flex-shrink:0\}/u);
  assert.ok(top.indexOf("className: 'wf-controls'") < top.indexOf("className: 'wf-start'"));
  assert.match(source, /white-space:nowrap/u);
  assert.match(source, /slots\.inject\('sidebar\.footer\.action'/u);
  assert.match(source, /slots\.inject\('shell\.overlay'/u);
  assert.match(source, /records === null \? h\('p',[^\n]+t\('recordsPending'\)/u);
  assert.match(source, /disabled: disabled \|\| !settings/u);
});

test('model-facing footprint is fixed rather than a full activity-history injection', t => {
  const tools = createToolDefinitions(async () => ({})).map(({ name, description, parameters }) => ({ name, description, parameters }));
  const schemaCharacters = JSON.stringify(tools).length;
  t.diagnostic(`Five bounded tool schemas: ${schemaCharacters} Unicode characters; fixed guidance: ${WORKFILES_PROMPT.length} characters. Not a tokenizer-based token count.`);
  assert.equal(tools.length, 5); assert.ok(schemaCharacters < 8000); assert.ok(WORKFILES_PROMPT.length < 1500);
});
