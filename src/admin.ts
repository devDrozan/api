import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import { RemoteConfigSchema } from './remote-config.js';

const closed = { additionalProperties: false } as const;
const bilingual = Type.Object({ en: Type.String({ minLength: 1, maxLength: 400 }), my: Type.String({ minLength: 1, maxLength: 400 }) }, closed);
const https = Type.String({ minLength: 8, maxLength: 2048, pattern: '^https://' });
export const RemittanceSchema = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 120 }), from: Type.Literal('KRW'), to: Type.Literal('MMK'),
  rate: Type.String({ pattern: '^(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,12})?$' }),
  source: https, verifiedAt: Type.String({ minLength: 20, maxLength: 35 }),
}, closed);
export const ContentSchema = Type.Object({
  config: RemoteConfigSchema,
  banners: Type.Array(Type.Object({
    id: Type.String({ pattern: '^[a-z0-9-]{1,40}$' }), title: bilingual, body: bilingual,
    imageUrl: https, link: Type.String({ minLength: 1, maxLength: 2048 }),
    order: Type.Integer({ minimum: 0, maximum: 1000 }), visible: Type.Boolean(),
  }, closed), { maxItems: 8 }),
}, closed);
export const DocumentStateSchema = Type.Object({
  version: Type.Integer({ minimum: 0 }),
  draft: Type.Union([RemittanceSchema, ContentSchema, Type.Null()]),
  published: Type.Union([RemittanceSchema, ContentSchema, Type.Null()]),
  history: Type.Array(Type.Object({ id: Type.Integer(), action: Type.String(), actor: Type.String(), createdAt: Type.String(), payload: Type.Union([RemittanceSchema, ContentSchema]) }, closed)),
}, closed);
export type Remittance = Static<typeof RemittanceSchema>;
export type Content = Static<typeof ContentSchema>;
export type Kind = 'remittance' | 'content';
export type Payload = Remittance | Content;
export type DocumentState = { version: number; draft: Payload | null; published: Payload | null; history: { id: number; action: string; actor: string; createdAt: string; payload: Payload }[] };
export class AdminError extends Error {
  constructor(public statusCode: number, public code: string, public field = '') { super(code); }
}
const routes = new Set(['/severance', '/severance/guide', '/insurance', '/exchange', '/salary', '/expenses']);
export function safeHttps(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname; } catch { return false; }
}
export function validatePayload(kind: Kind, payload: unknown, now = new Date()): asserts payload is Payload {
  if (!Value.Check(kind === 'remittance' ? RemittanceSchema : ContentSchema, payload)) throw new AdminError(400, 'INVALID_INPUT', 'payload');
  if (kind === 'remittance') {
    const p = payload as Remittance;
    const day = p.verifiedAt.slice(0, 10);
    const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
    if (!validDay || !/[1-9]/.test(p.rate) || !p.provider.trim() || !safeHttps(p.source) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(p.verifiedAt) ||
        !Number.isFinite(Date.parse(p.verifiedAt)) || Date.parse(p.verifiedAt) > now.getTime()) throw new AdminError(400, 'INVALID_INPUT', 'payload');
  } else {
    const p = payload as Content;
    for (const items of [p.config.carousel, p.config.notices, p.banners]) {
      if (new Set(items.map(i => i.id)).size !== items.length) throw new AdminError(400, 'DUPLICATE_ID', 'payload');
    }
    if (p.banners.some(b => !safeHttps(b.imageUrl) || !(routes.has(b.link) || safeHttps(b.link)))) throw new AdminError(400, 'UNSAFE_URL', 'banners');
  }
}
export interface AdminStore {
  authorize(token: string): Promise<string>;
  read(kind: Kind): Promise<DocumentState>;
  readPublished?(kind: Kind): Promise<Payload | null>;
  mutate(kind: Kind, actor: string, action: 'draft' | 'publish' | 'rollback', expectedVersion: number, payload?: Payload, revisionId?: number): Promise<DocumentState>;
}
export function createAdminStore(): AdminStore | undefined {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return undefined;
  let client: SupabaseClient;
  try { client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) } }); } catch { return undefined; }
  async function read(kind: Kind): Promise<DocumentState> {
    const [state, history] = await Promise.all([
      client.from('admin_documents').select('version,draft,published').eq('kind', kind).maybeSingle(),
      client.from('admin_history').select('id,action,actor,created_at,payload').eq('kind', kind).order('id', { ascending: false }).limit(50),
    ]);
    if (state.error || history.error) throw new AdminError(503, 'ADMIN_UNAVAILABLE');
    return { version: state.data?.version ?? 0, draft: state.data?.draft ?? null, published: state.data?.published ?? null,
      history: (history.data ?? []).map(h => ({ id: h.id, action: h.action, actor: h.actor, createdAt: h.created_at, payload: h.payload })) };
  }
  return {
    async authorize(token) {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user || data.user.is_anonymous) throw new AdminError(401, 'UNAUTHENTICATED');
      const membership = await client.from('admin_members').select('user_id').eq('user_id', data.user.id).eq('active', true).maybeSingle();
      if (membership.error) throw new AdminError(503, 'ADMIN_UNAVAILABLE');
      if (!membership.data) throw new AdminError(403, 'ADMIN_REQUIRED');
      return data.user.id;
    }, read,
    async readPublished(kind) {
      const { data, error } = await client.from('admin_documents').select('published').eq('kind', kind).maybeSingle();
      if (error) throw new AdminError(503, 'ADMIN_UNAVAILABLE');
      return data?.published ?? null;
    },
    async mutate(kind, actor, action, expectedVersion, payload, revisionId) {
      const { error } = await client.rpc('admin_edit_document', { p_kind: kind, p_actor: actor, p_action: action, p_expected_version: expectedVersion, p_payload: payload ?? null, p_revision_id: revisionId ?? null });
      if (error) {
        if (error.message.includes('VERSION_CONFLICT')) throw new AdminError(409, 'VERSION_CONFLICT');
        if (error.message.includes('ADMIN_REQUIRED')) throw new AdminError(403, 'ADMIN_REQUIRED');
        if (error.message.includes('REVISION_NOT_FOUND')) throw new AdminError(404, 'REVISION_NOT_FOUND');
        throw new AdminError(503, 'ADMIN_UNAVAILABLE');
      }
      return read(kind);
    },
  };
}
const Params = Type.Object({ kind: Type.Union([Type.Literal('remittance'), Type.Literal('content')]) }, closed);
const version = Type.Integer({ minimum: 0, maximum: 2147483646 });
export async function registerAdmin(server: FastifyInstance, store?: AdminStore) {
  await server.register(async scoped => {
    scoped.addHook('onRequest', async (request) => {
      if (process.env.ADMIN_ENABLED !== 'true' || !store) throw new AdminError(503, 'ADMIN_DISABLED');
      const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '');
      if (!match?.[1]) throw new AdminError(401, 'UNAUTHENTICATED');
      (request as typeof request & { adminId: string }).adminId = await store.authorize(match[1]);
    });
    scoped.get('/v1/admin/session', { schema: { operationId: 'adminSession', security: [{ adminBearer: [] }], response: { 200: Type.Object({ id: Type.String() }, closed) } } }, async request => ({ id: (request as typeof request & { adminId: string }).adminId }));
    scoped.get<{ Params: { kind: Kind } }>('/v1/admin/documents/:kind', { schema: { operationId: 'getAdminDocument', security: [{ adminBearer: [] }], params: Params, response: { 200: DocumentStateSchema } } }, request => store!.read(request.params.kind));
    for (const action of ['draft', 'publish', 'rollback'] as const) {
      const body = action === 'draft' ? Type.Object({ expectedVersion: version, payload: Type.Union([RemittanceSchema, ContentSchema]) }, closed)
        : action === 'rollback' ? Type.Object({ expectedVersion: version, revisionId: Type.Integer({ minimum: 1 }) }, closed)
        : Type.Object({ expectedVersion: version }, closed);
      scoped.post<{ Params: { kind: Kind }; Body: { expectedVersion: number; payload?: Payload; revisionId?: number } }>(`/v1/admin/documents/:kind/${action}`, { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { operationId: `admin${action}`, security: [{ adminBearer: [] }], params: Params, body, response: { 200: DocumentStateSchema } } }, async request => {
        const { kind } = request.params;
        if (action === 'draft') validatePayload(kind, request.body.payload);
        else {
          const state = await store!.read(kind);
          const target = action === 'publish' ? state.draft : state.history.find(h => h.id === request.body.revisionId)?.payload;
          if (!target) throw new AdminError(404, 'REVISION_NOT_FOUND');
          validatePayload(kind, target);
        }
        return store!.mutate(kind, (request as typeof request & { adminId: string }).adminId, action, request.body.expectedVersion, request.body.payload, request.body.revisionId);
      });
    }
  });
}
