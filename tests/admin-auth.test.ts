import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), create: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
import { createAdminStore } from '../src/admin.js';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('verifies the bearer token with Auth and checks active database membership instead of role metadata', async () => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('SUPABASE_SECRET_KEY', 'server-secret-test-only');
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  mocks.from.mockReturnValue(query); mocks.create.mockReturnValue({ auth: { getUser: mocks.getUser }, from: mocks.from });
  const store = createAdminStore()!;
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad token' } });
  await expect(store.authorize('expired')).rejects.toMatchObject({ statusCode: 401 }); expect(mocks.from).not.toHaveBeenCalled();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'ordinary', user_metadata: { role: 'admin' } } }, error: null });
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
  await expect(store.authorize('ordinary-token')).rejects.toMatchObject({ statusCode: 403 });
  expect(mocks.getUser).toHaveBeenLastCalledWith('ordinary-token');
  expect(mocks.from).toHaveBeenLastCalledWith('admin_members');
  expect(query.eq).toHaveBeenCalledWith('user_id', 'ordinary'); expect(query.eq).toHaveBeenCalledWith('active', true);
  query.maybeSingle.mockResolvedValue({ data: { user_id: 'ordinary' }, error: null });
  await expect(store.authorize('admin-token')).resolves.toBe('ordinary');
  query.maybeSingle.mockResolvedValue({ data: null, error: { message: 'offline' } });
  await expect(store.authorize('admin-token')).rejects.toMatchObject({ statusCode: 503, code: 'ADMIN_UNAVAILABLE' });
});
it('does not construct a storage client without server credentials', () => {
  vi.stubEnv('SUPABASE_URL', ''); vi.stubEnv('SUPABASE_SECRET_KEY', '');
  expect(createAdminStore()).toBeUndefined(); expect(mocks.create).not.toHaveBeenCalled();
});
