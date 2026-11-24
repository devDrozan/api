import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { AdminError, validatePayload, type AdminStore, type DocumentState, type Kind } from '../src/admin.js';
import { defaultRemoteConfig } from '../src/remote-config.js';

const rate = { provider: 'Example', from: 'KRW', to: 'MMK', rate: '2.738800000001', source: 'https://example.com/rates', verifiedAt: '2026-01-01T00:00:00Z' };
const content = { config: { ...defaultRemoteConfig, revision: 'admin-1' }, banners: [{ id: 'one', title: { en: 'Hello', my: 'မင်္ဂလာပါ' }, body: { en: 'Body', my: 'အကြောင်းအရာ' }, imageUrl: 'https://example.com/banner.png', link: '/insurance', order: 1, visible: true }] };
function mockStore() {
  const states: Record<Kind, DocumentState> = { remittance: { version: 0, draft: null, published: null, history: [] }, content: { version: 0, draft: null, published: null, history: [] } };
  const store: AdminStore = {
    authorize: vi.fn(async token => { if (token === 'ordinary') throw new AdminError(403, 'ADMIN_REQUIRED'); if (token !== 'admin') throw new AdminError(401, 'UNAUTHENTICATED'); return 'admin-id'; }),
    read: vi.fn(async kind => structuredClone(states[kind])),
    mutate: vi.fn(async (kind, actor, action, expectedVersion, payload, revisionId) => {
      const state = states[kind];
      if (state.version !== expectedVersion) throw new AdminError(409, 'VERSION_CONFLICT');
      const selected = action === 'publish' ? state.draft : action === 'rollback' ? state.history.find(h => h.id === revisionId)?.payload : payload;
      if (!selected) throw new AdminError(404, 'REVISION_NOT_FOUND');
      state.version++;
      if (action === 'publish') state.published = selected; else state.draft = selected;
      state.history.unshift({ id: state.version, action, actor, createdAt: new Date().toISOString(), payload: selected });
      return structuredClone(state);
    }),
  };
  return { states, store };
}
afterEach(() => vi.unstubAllEnvs());
it('fails closed when disabled and authenticates before validating or accessing documents', async () => {
  const { store } = mockStore();
  const server = await buildServer({ admin: store });
  try {
    vi.stubEnv('ADMIN_ENABLED', 'false');
    expect((await server.inject('/v1/admin/session')).statusCode).toBe(503);
    vi.stubEnv('ADMIN_ENABLED', 'true');
    for (const [authorization, status] of [['', 401], ['Bearer expired', 401], ['Bearer ordinary', 403]] as const) {
      const response = await server.inject({ method: 'POST', url: '/v1/admin/documents/content/draft', headers: { authorization }, payload: {} });
      expect(response.statusCode).toBe(status);
    }
    expect(store.read).not.toHaveBeenCalled(); expect(store.mutate).not.toHaveBeenCalled();
    expect((await server.inject({ url: '/v1/admin/session', headers: { authorization: 'Bearer admin' } })).json()).toEqual({ id: 'admin-id' });
  } finally { await server.close(); }
});
it('separates draft, published and rollback states; rejects concurrent stale edits and unsafe input', async () => {
  vi.stubEnv('ADMIN_ENABLED', 'true'); vi.stubEnv('ADMIN_PUBLIC_CONTENT_ENABLED', 'true');
  const { store, states } = mockStore(); const server = await buildServer({ admin: store });
  const post = (kind: Kind, action: string, payload: unknown) => server.inject({ method: 'POST', url: `/v1/admin/documents/${kind}/${action}`, headers: { authorization: 'Bearer admin' }, payload });
  try {
    expect((await post('remittance', 'draft', { expectedVersion: 0, payload: rate })).statusCode).toBe(200);
    expect(states.remittance.published).toBeNull();
    expect((await post('remittance', 'publish', { expectedVersion: 1 })).statusCode).toBe(200);
    expect((await server.inject('/v1/remittance-rates/krw-mmk')).json()).toEqual(rate);
    expect((await post('remittance', 'draft', { expectedVersion: 1, payload: rate })).statusCode).toBe(409);
    expect((await post('remittance', 'draft', { expectedVersion: 2, payload: { ...rate, rate: '0' } })).statusCode).toBe(400);
    expect((await post('remittance', 'draft', { expectedVersion: 2, payload: { ...rate, secret: 'no' } })).statusCode).toBe(400);
    expect((await post('remittance', 'draft', { expectedVersion: 2, payload: content })).statusCode).toBe(400);
    expect((await post('remittance', 'draft', { expectedVersion: 2, payload: { ...rate, rate: '3' } })).statusCode).toBe(200);
    expect((await post('remittance', 'rollback', { expectedVersion: 3, revisionId: 1 })).statusCode).toBe(200);
    expect(states.remittance.draft).toEqual(rate); expect(states.remittance.published).toEqual(rate);
    expect((await post('content', 'draft', { expectedVersion: 0, payload: content })).statusCode).toBe(200);
    expect((await server.inject('/v1/app-content')).json().banners).toEqual([]);
    expect((await post('content', 'publish', { expectedVersion: 1 })).statusCode).toBe(200);
    expect((await server.inject('/v1/app-content')).json()).toEqual(content);
    expect((await server.inject('/v1/mobile-config')).json()).toEqual(content.config);
  } finally { await server.close(); }
});
it('ignores unpublished/disabled content and projects visible ordered public banners without history', async () => {
  const { store, states } = mockStore(); states.content.published = { ...content, banners: [ { ...content.banners[0]!, id: 'hidden', visible: false }, { ...content.banners[0]!, id: 'last', order: 10 }, content.banners[0]! ] };
  const server = await buildServer({ admin: store });
  try {
    vi.stubEnv('ADMIN_PUBLIC_CONTENT_ENABLED', 'false');
    expect((await server.inject('/v1/app-content')).json().banners).toEqual([]);
    expect(store.read).not.toHaveBeenCalled();
    vi.stubEnv('ADMIN_PUBLIC_CONTENT_ENABLED', 'true');
    const response = await server.inject('/v1/app-content');
    expect(response.json().banners.map((b: { id: string }) => b.id)).toEqual(['one', 'last']);
    expect(response.json()).not.toHaveProperty('history'); expect(response.headers['cache-control']).toBe('no-store');
  } finally { await server.close(); }
});
it('validates decimal precision, links, duplicates, future verification dates and remote control boundaries', () => {
  expect(() => validatePayload('remittance', rate)).not.toThrow();
  for (const patch of [{ rate: '-1' }, { rate: '1e2' }, { rate: '0' }, { rate: '0.0000000000001' }, { source: 'javascript:alert(1)' }, { verifiedAt: '2999-01-01T00:00:00Z' }, { provider: ' ' }]) {
    expect(() => validatePayload('remittance', { ...rate, ...patch })).toThrow();
  }
  for (const value of [{ ...content, banners: [content.banners[0], content.banners[0]] }, { ...content, banners: [{ ...content.banners[0], link: 'file:///secret' }] }, { ...content, config: { ...content.config, features: { ...content.config.features, calculationEnabled: false } } }]) expect(() => validatePayload('content', value)).toThrow();
});
