import { z } from 'zod';
import { ApplicationIdSchema, normalizeActivityUrl } from './activity-policy.js';

export const FORMAT = 'deepseek-workfiles/v1';
export const TOOL_ACTIONS = Object.freeze({ workfiles_search: 'search', workfiles_inspect: 'inspect', workfiles_open: 'open', workfiles_context: 'context', workfiles_history: 'history' });
const Candidate = z.object({
  id: z.string().length(39).regex(/^wf-[0-9a-f-]{36}$/u), name: z.string().max(4096), path: z.string().max(8192), folder: z.string().max(8192),
  root: z.string().max(8192), relativePath: z.string().max(8192), extension: z.string().max(12), bytes: z.number().nonnegative(), modifiedAt: z.string().max(64),
  _identity: z.object({ key: z.string().max(128), mtimeMs: z.number(), bytes: z.number().nonnegative(), version: z.string().max(4096) }),
  contentStatus: z.string().max(32),
  match: z.object({ quality: z.enum(['all_terms', 'partial']), matchedTerms: z.array(z.string().max(512)).max(16), sources: z.array(z.enum(['name', 'folder', 'content'])).max(3) }).optional(),
});
const WebCandidate = z.object({
  id: z.string().length(39).regex(/^wa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  name: z.string().min(1).max(512), url: z.string().max(2048).refine(value => normalizeActivityUrl(value) === value),
  app: z.object({ id: ApplicationIdSchema, name: z.string().min(1).max(256) }).strict(),
  observedAt: z.string().max(64).datetime({ offset: true }),
}).strict();
export const ContextSchema = z.object({
  version: z.literal(1), candidates: z.array(Candidate).max(20), previousCandidates: z.array(Candidate).max(20), recent: z.array(Candidate).max(8),
  lastSearch: z.object({ query: z.string().max(512), sort: z.string().max(32), at: z.string().max(64) }).nullable(),
  lastOpened: z.object({ candidate: Candidate, requestedAt: z.string().max(64), status: z.literal('open_requested') }).nullable(),
  webCandidates: z.array(WebCandidate).max(20).default([]),
  lastWebOpened: z.object({ candidate: WebCandidate, requestedAt: z.string().max(64), status: z.literal('open_requested') }).nullable().default(null),
  // Turn that produced the current webCandidates. A newer user request invalidates it,
  // so an old wa-ID cannot be reopened from a stale tool result.
  historyTurn: z.number().int().nonnegative().nullable().default(null),
  updatedAt: z.string().max(64).nullable(),
});
export const ProjectionSchema = z.object({ turn: z.number().int().nonnegative().default(0), context: ContextSchema, tools: z.record(z.string(), z.string()), commands: z.record(z.string(), z.string()) });
export function emptyContext() { return { version: 1, candidates: [], previousCandidates: [], recent: [], lastSearch: null, lastOpened: null, webCandidates: [], lastWebOpened: null, historyTurn: null, updatedAt: null }; }
function remember(map, key, value) { return Object.fromEntries([...Object.entries(map), [key, value]].slice(-128)); }
function omit(map, key) { const next = { ...map }; delete next[key]; return next; }
function parsedSnapshot(text, expectedAction) {
  if (typeof text !== 'string' || text.length > 256000) return undefined;
  try {
    const value = JSON.parse(text);
    if (value.format !== FORMAT || value.ok !== true || (expectedAction && value.action !== expectedAction)) return undefined;
    const parsed = ContextSchema.safeParse(value.context);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Pure projection: only correlated results of this plugin's tools/human command may carry state. */
export function foldContext(state, event) {
  // Every new human request starts a new turn: queries from the previous turn are stale.
  if (event.type === 'user/message') return { ...state, turn: (state.turn ?? 0) + 1 };
  if (event.type === 'tool/call' && Object.hasOwn(TOOL_ACTIONS, event.data.name)) {
    return { ...state, tools: remember(state.tools, event.data.callId, TOOL_ACTIONS[event.data.name]) };
  }
  if (event.type === 'tool/result') {
    const message = event.data.message;
    const callId = message?.toolCallId ?? message?.source?.callId;
    const expected = state.tools[callId];
    if (!expected) return state;
    const next = { ...state, tools: omit(state.tools, callId) };
    if (message.isError) return next;
    const text = message.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const context = parsedSnapshot(text, expected);
    return context ? { ...next, context } : next;
  }
  if (event.type === 'command/run' && event.data.name === 'workfiles') {
    return { ...state, commands: remember(state.commands, event.data.commandId, 'workfiles') };
  }
  if (event.type === 'command/done' && state.commands[event.data.commandId]) {
    const next = { ...state, commands: omit(state.commands, event.data.commandId) };
    if (event.data.kind !== 'success') return next;
    const context = parsedSnapshot(event.data.text);
    return context ? { ...next, context } : next;
  }
  return state;
}
export function contextProjection() {
  return { key: 'workfiles', stateVersion: 4, stateSchema: ProjectionSchema,
    init: () => ({ turn: 0, context: emptyContext(), tools: {}, commands: {} }), apply: foldContext };
}
export function findWebCandidate(context, id) {
  if (typeof id !== 'string' || id.length !== 39 || !/^wa-[0-9a-f-]{36}$/u.test(id)) return undefined;
  return [...(context.webCandidates ?? []), ...(context.lastWebOpened ? [context.lastWebOpened.candidate] : [])].find(candidate => candidate.id === id);
}
export function findCandidate(context, id) {
  if (typeof id !== 'string' || !/^wf-[0-9a-f-]{36}$/u.test(id)) return undefined;
  return [...context.candidates, ...context.previousCandidates, ...context.recent, ...(context.lastOpened ? [context.lastOpened.candidate] : [])].find(candidate => candidate.id === id);
}
