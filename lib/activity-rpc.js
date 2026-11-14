import { z } from 'zod';
import { ApplicationIdSchema, MAX_ACTIVITY_APPLICATIONS } from './activity-policy.js';

export const ACTIVITY_RPC_PACKAGE = '@local/deepseek-workfiles/activity';
export const ACTIVITY_RPC_ID = `${ACTIVITY_RPC_PACKAGE}#workfilesActivity/action`;
const AppIds = z.array(ApplicationIdSchema).max(MAX_ACTIVITY_APPLICATIONS).refine(values => new Set(values).size === values.length);
const ObservedId = z.string().length(39).regex(/^wa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const IsoDate = z.string().max(64).datetime({ offset: true });
const PathInput = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const action = (name, fields = {}) => z.object({ action: z.literal(name), ...fields }).strict();
export const ActivityActionSchema = z.discriminatedUnion('action', [
  action('status', { refresh: z.boolean().optional() }),
  action('configure', { enabled: z.boolean().optional(), applications: AppIds.optional(), contextApplications: AppIds.optional() })
    .refine(value => !value.applications || !value.contextApplications || value.contextApplications.every(id => value.applications.includes(id))),
  action('set_application', { id: ApplicationIdSchema, selected: z.boolean() }),
  action('set_context', { id: ApplicationIdSchema, allowed: z.boolean() }),
  action('discover_applications'),
  // One explicit Human click: discover currently running GUI apps and select them
  // atomically on top of the latest saved policy. It never grants window metadata.
  action('select_running_applications'),
  action('open_observed', { id: ObservedId }),
  action('list', { query: z.string().max(512).optional(), after: IsoDate.optional(), before: IsoDate.optional(), limit: z.number().int().min(1).max(20).optional() }),
  action('clear'), action('open_accessibility'), action('folders'),
  action('add_root', { path: PathInput }), action('remove_root', { path: PathInput }),
  action('set_search_enabled', { enabled: z.boolean() }),
  action('voice_status'), action('voice_show'), action('voice_record'), action('voice_cancel'),
  action('voice_shortcut', { shortcut: z.string().min(3).max(100).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)) }),
]);
const JsonData = z.json().refine(value => JSON.stringify(value).length <= 262144, 'The response exceeds its bounded UI budget.');
export const ActivityResultSchema = z.object({ ok: z.literal(true), data: JsonData }).strict();
const codec = (name, schema) => Object.freeze({ mode: 'strict', typeSymbol: `${ACTIVITY_RPC_PACKAGE}#${name}`, create: () => schema });
/** Explicit public Typert descriptor. No private Gateway dispatch or transport is used. */
export const ActivityInvocation = Object.freeze({
  id: ACTIVITY_RPC_ID, service: 'workfilesActivity', namespace: 'workfilesActivity', method: 'action',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([{ name: 'input', wire: 'input', source: 'json', codec: codec('ActivityAction', ActivityActionSchema) }]),
  cancellation: Object.freeze({ parameter: 'signal' }), result: codec('ActivityResult', ActivityResultSchema),
  description: 'Owner-only document assistant settings, bounded recent activity and explicit desktop voice actions. Never available as a model configuration tool.',
});
export const ActivityHostContribution = Object.freeze({
  package: ACTIVITY_RPC_PACKAGE, face: 'host', schemas: [], invocations: [ActivityInvocation],
  model: { services: [{ key: 'workfilesActivity', exportName: 'WorkfilesActivity', description: ActivityInvocation.description,
    tags: [], members: [{ kind: 'method', name: 'action', signature: 'action(input: ActivityAction, signal: AbortSignal): Promise<ActivityResult>' }], types: [] }], events: [], objects: [] },
});

/** The Service base is the public SDK peer supplied by the Host entry. A plain
 * ctx.provide object would NOT rebind this.ctx.invocation (verified on rc.2).
 * Keep the owner/interactions gate here, not in a caller-supplied JSON field.
 */
export function registerActivityRemote(ctx, perform, Service) {
  if (typeof Service !== 'function' || typeof perform !== 'function') throw new TypeError('The public Cordis Service and operation are required.');
  class WorkfilesActivity extends Service {
    constructor(owner) {
      super(owner, 'workfilesActivity');
      this.typertRemote = Object.freeze({ service: this, serviceKey: 'workfilesActivity', namespace: 'workfilesActivity' });
    }
    async action(input, signal) {
      const invocation = this.ctx.invocation;
      if (invocation?.peer?.principal?.kind !== 'owner' || invocation.peer.interactions !== 'answer') throw new Error('请由本机用户在资料助手界面操作。');
      signal?.throwIfAborted();
      const parsed = ActivityActionSchema.parse(input);
      const value = await perform(parsed, signal);
      signal?.throwIfAborted();
      // Public status sometimes has optional undefined fields. They are absence,
      // not an RPC value; normalize only our bounded, plugin-owned result.
      return ActivityResultSchema.parse({ ok: true, data: JSON.parse(JSON.stringify(value ?? null)) });
    }
  }
  const service = new WorkfilesActivity(ctx);
  const withdraw = ctx.typert.register(ActivityHostContribution);
  ctx.effect(() => withdraw);
  return service;
}
