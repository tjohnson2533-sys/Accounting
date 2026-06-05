-- Supabase platform primitives that the LedgerPro migrations depend on but that the
-- Supabase stack normally provides (roles, the auth schema, auth.uid()). Applying this
-- first lets the real migrations + RLS smoke test run on a plain PostgreSQL server (CI,
-- or local dev without Docker). It is NOT part of the application migration set.
do $$ begin
  if not exists (select from pg_roles where rolname='anon')          then create role anon          nologin noinherit; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname='service_role')  then create role service_role  nologin noinherit bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id          uuid primary key,
  instance_id uuid,
  aud         varchar(255),
  role        varchar(255),
  email       varchar(255),
  created_at  timestamptz,
  updated_at  timestamptz
);

-- Supabase's auth.uid(): the JWT 'sub' claim carried on the request GUC.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
