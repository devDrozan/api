import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('applies migration and enforces database privileges, publish atomicity and rollback isolation', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      insert into auth.users values ('00000000-0000-0000-0000-000000000001');`);
    await db.exec(await readFile(new URL('../supabase/migrations/202611220001_admin.sql', import.meta.url), 'utf8'));
    const checks = await db.query<{ allowed: boolean }>(`select has_table_privilege('anon','public.admin_documents','SELECT') as allowed
      union all select has_table_privilege('authenticated','public.admin_members','INSERT')
      union all select has_function_privilege('authenticated','public.admin_edit_document(text,uuid,text,integer,jsonb,bigint)','EXECUTE')`);
    expect(checks.rows.every(r => !r.allowed)).toBe(true);
    await db.exec(`set role anon`);
    await expect(db.query('select * from public.admin_documents')).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
    await db.exec(`insert into public.admin_members(user_id) values ('00000000-0000-0000-0000-000000000001'); set role service_role`);
    const edit = (action: string, version: number, payload: unknown = null, revision: number | null = null, actor = '00000000-0000-0000-0000-000000000001') => db.query('select public.admin_edit_document($1,$2,$3,$4,$5,$6)', ['remittance', actor, action, version, payload, revision]);
    await expect(edit('draft', 0, { rate: '3' }, null, '00000000-0000-0000-0000-000000000002')).rejects.toThrow('ADMIN_REQUIRED');
    await edit('draft', 0, { rate: '2.738800000001' });
    expect((await db.query('select published from public.admin_documents')).rows[0]).toEqual({ published: null });
    await edit('publish', 1);
    await expect(edit('draft', 1, { rate: '9' })).rejects.toThrow('VERSION_CONFLICT');
    await edit('draft', 2, { rate: '3' });
    const first = await db.query<{ id: number }>('select id from public.admin_history order by id limit 1');
    await edit('rollback', 3, null, first.rows[0]!.id);
    expect((await db.query('select version,draft,published from public.admin_documents')).rows[0]).toEqual({ version: 4, draft: { rate: '2.738800000001' }, published: { rate: '2.738800000001' } });
    await expect(edit('rollback', 4, null, 999)).rejects.toThrow('REVISION_NOT_FOUND');
    expect((await db.query('select count(*)::int as count from public.admin_history')).rows[0]).toEqual({ count: 4 });
    await db.exec(`reset role; update public.admin_members set active=false; set role service_role;`);
    await expect(edit('publish', 4)).rejects.toThrow('ADMIN_REQUIRED');
    expect((await db.query('select version from public.admin_documents')).rows[0]).toEqual({ version: 4 });
  } finally { await db.close(); }
}, 20000);
