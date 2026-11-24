-- PREPARED ONLY. Apply to staging first; production requires owner approval.
-- Existing remittance_rates is deliberately untouched.
begin;
create table public.admin_members (user_id uuid primary key references auth.users(id) on delete cascade, active boolean not null default true);
create table public.admin_documents (
  kind text primary key check (kind in ('remittance','content')),
  version integer not null default 0 check (version >= 0), draft jsonb, published jsonb
);
create table public.admin_history (
  id bigint generated always as identity primary key,
  kind text not null references public.admin_documents(kind),
  action text not null check (action in ('draft','publish','rollback')),
  actor uuid not null, created_at timestamptz not null default now(), payload jsonb not null
);
create index admin_history_kind_id on public.admin_history(kind,id desc);
alter table public.admin_members enable row level security;
alter table public.admin_documents enable row level security;
alter table public.admin_history enable row level security;
-- No browser role gets direct access, including signed-in admins.
revoke all on public.admin_members, public.admin_documents, public.admin_history from public, anon, authenticated;
grant select on public.admin_members, public.admin_documents, public.admin_history to service_role;
grant insert, update on public.admin_documents to service_role;
grant insert on public.admin_history to service_role;
grant usage, select on sequence public.admin_history_id_seq to service_role;
-- Invoker function callable only by the server service_role. Check membership
-- again transactionally. Lock the document to reject concurrent stale edits.
create function public.admin_edit_document(
  p_kind text, p_actor uuid, p_action text, p_expected_version integer,
  p_payload jsonb default null, p_revision_id bigint default null
) returns void language plpgsql security invoker set search_path = '' as $$
declare current_doc public.admin_documents; selected_payload jsonb;
begin
  if not exists(select 1 from public.admin_members where user_id=p_actor and active) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_kind not in ('remittance','content') or p_action not in ('draft','publish','rollback') then raise exception 'INVALID_INPUT'; end if;
  insert into public.admin_documents(kind) values(p_kind) on conflict do nothing;
  select * into current_doc from public.admin_documents where kind=p_kind for update;
  if current_doc.version <> p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
  if p_action='draft' then selected_payload := p_payload;
  elsif p_action='publish' then selected_payload := current_doc.draft;
  else select payload into selected_payload from public.admin_history where id=p_revision_id and kind=p_kind;
  end if;
  if selected_payload is null then raise exception 'REVISION_NOT_FOUND'; end if;
  update public.admin_documents set version=version+1,
    draft=case when p_action='publish' then draft else selected_payload end,
    published=case when p_action='publish' then selected_payload else published end where kind=p_kind;
  insert into public.admin_history(kind,action,actor,payload) values(p_kind,p_action,p_actor,selected_payload);
end $$;
revoke all on function public.admin_edit_document(text,uuid,text,integer,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.admin_edit_document(text,uuid,text,integer,jsonb,bigint) to service_role;
commit;
-- Bootstrap/revoke admins only through the trusted SQL console:
-- insert into public.admin_members(user_id) values ('EXISTING_AUTH_USER_UUID');
-- update public.admin_members set active=false where user_id='EXISTING_AUTH_USER_UUID';
