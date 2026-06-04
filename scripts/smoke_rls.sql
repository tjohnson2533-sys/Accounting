-- Live RLS + lockdown smoke test for LedgerPro (firm-internal).
-- Run against a local Supabase DB AFTER migrations 0001-0004 are applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f scripts/smoke_rls.sql
-- Prints PASS/FAIL per check and exits nonzero if any check is red.
--
-- Notes:
--  * Two staff users are placed in two different entities to prove tenant isolation.
--  * RLS is exercised by `set local role authenticated` + a request.jwt.claims `sub`,
--    exactly as PostgREST presents an authenticated session. Results are smuggled out of
--    the role-switched transaction via session GUCs (the temp results table is owned by
--    postgres and not writable as `authenticated`).
--  * The balance trigger is DEFERRABLE INITIALLY DEFERRED, so it fires at COMMIT — the
--    unbalanced call is therefore wrapped in its own transaction whose COMMIT must fail.

\set ON_ERROR_STOP off
\timing off
\pset pager off

-- Fixed UUIDs so the script is self-contained and idempotent.
-- A: user aaaa… in entity a111…   B: user bbbb… in entity b222…

create temp table if not exists smoke_results (ord int, name text, passed boolean, detail text);
truncate smoke_results;

-- ---------- setup (as postgres / superuser; bypasses RLS) ----------
begin;
  delete from entities where id in
    ('a1111111-1111-1111-1111-111111111111','b2222222-2222-2222-2222-222222222222');

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
     'authenticated','authenticated','smoke_a@firm.test', now(), now()),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','00000000-0000-0000-0000-000000000000',
     'authenticated','authenticated','smoke_b@firm.test', now(), now())
  on conflict (id) do nothing;

  insert into entities (id, name) values
    ('a1111111-1111-1111-1111-111111111111','Smoke Client A'),
    ('b2222222-2222-2222-2222-222222222222','Smoke Client B');

  insert into memberships (user_id, entity_id, role) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a1111111-1111-1111-1111-111111111111','preparer'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','b2222222-2222-2222-2222-222222222222','preparer');

  insert into accounts (id, entity_id, code, name, type, is_bank) values
    ('ac111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','1000','Cash A','asset',true),
    ('ac222222-2222-2222-2222-222222222222','a1111111-1111-1111-1111-111111111111','6000','Expense A','expense',false),
    ('ac333333-3333-3333-3333-333333333333','b2222222-2222-2222-2222-222222222222','1000','Cash B','asset',true);

  -- one balanced seed transaction per entity
  insert into transactions (id, entity_id, txn_date, source, status, content_hash) values
    ('d1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','2025-01-15','manual_je','posted','smoke-seed-A'),
    ('d2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222','2025-01-15','manual_je','posted','smoke-seed-B');
  insert into postings (transaction_id, entity_id, account_id, amount) values
    ('d1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','ac111111-1111-1111-1111-111111111111', 100),
    ('d1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','ac222222-2222-2222-2222-222222222222', -100);
  insert into postings (transaction_id, entity_id, account_id, amount) values
    ('d2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222','ac333333-3333-3333-3333-333333333333', 100),
    ('d2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222','ac333333-3333-3333-3333-333333333333', -100);
commit;

-- ---------- RLS isolation: user A ----------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  select set_config('smoke.a_only_txn',
    (count(*) > 0 and bool_and(entity_id = 'a1111111-1111-1111-1111-111111111111'))::text, false)
    from transactions;
  select set_config('smoke.a_only_post',
    (count(*) > 0 and bool_and(entity_id = 'a1111111-1111-1111-1111-111111111111'))::text, false)
    from postings;
commit;

-- ---------- RLS isolation: user B ----------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);
  select set_config('smoke.b_only_txn',
    (count(*) > 0 and bool_and(entity_id = 'b2222222-2222-2222-2222-222222222222'))::text, false)
    from transactions;
  select set_config('smoke.b_only_post',
    (count(*) > 0 and bool_and(entity_id = 'b2222222-2222-2222-2222-222222222222'))::text, false)
    from postings;
commit;

insert into smoke_results values
  (10,'RLS: user A sees ONLY entity A transactions',
      coalesce(current_setting('smoke.a_only_txn', true)::boolean, false), 'all visible txns are entity A'),
  (11,'RLS: user A sees ONLY entity A postings',
      coalesce(current_setting('smoke.a_only_post', true)::boolean, false), 'all visible postings are entity A'),
  (12,'RLS: user B sees ONLY entity B transactions',
      coalesce(current_setting('smoke.b_only_txn', true)::boolean, false), 'all visible txns are entity B'),
  (13,'RLS: user B sees ONLY entity B postings',
      coalesce(current_setting('smoke.b_only_post', true)::boolean, false), 'all visible postings are entity B');

-- ---------- balance trigger: unbalanced commit must be rejected at COMMIT ----------
begin;
  select commit_transaction(
    'a1111111-1111-1111-1111-111111111111'::uuid, '2025-02-01'::date, 'unbal', 'unbal',
    'manual_je'::txn_source, 'posted'::txn_status, 'smoke-unbal', null, null,
    '[{"account_id":"ac111111-1111-1111-1111-111111111111","amount":100}]'::jsonb);
commit;  -- expected: deferred trigger raises here, whole txn rolls back

insert into smoke_results values
  (20,'Balance trigger rejects an UNBALANCED commit_transaction',
      not exists (select 1 from transactions where content_hash = 'smoke-unbal'),
      'unbalanced transaction must not persist');

-- ---------- balance trigger: balanced commit succeeds ----------
begin;
  select commit_transaction(
    'a1111111-1111-1111-1111-111111111111'::uuid, '2025-02-02'::date, 'bal', 'bal',
    'manual_je'::txn_source, 'posted'::txn_status, 'smoke-bal', null, null,
    '[{"account_id":"ac111111-1111-1111-1111-111111111111","amount":100},
      {"account_id":"ac222222-2222-2222-2222-222222222222","amount":-100}]'::jsonb);
commit;

insert into smoke_results values
  (21,'Balanced commit_transaction succeeds',
      exists (select 1 from transactions where content_hash = 'smoke-bal'),
      'balanced transaction persisted');

-- ---------- lockdown: front-end roles cannot execute the write RPC ----------
insert into smoke_results values
  (30,'authenticated CANNOT execute commit_transaction',
      has_function_privilege('authenticated',
        'public.commit_transaction(uuid, date, text, text, txn_source, txn_status, text, uuid, uuid, jsonb)',
        'execute') = false,
      'execute must be revoked from authenticated'),
  (31,'anon CANNOT execute commit_transaction',
      has_function_privilege('anon',
        'public.commit_transaction(uuid, date, text, text, txn_source, txn_status, text, uuid, uuid, jsonb)',
        'execute') = false,
      'execute must be revoked from anon');

-- ---------- report ----------
\echo ''
\echo '================ SMOKE TEST RESULTS ================'
\pset format aligned
select lpad(ord::text, 3) as "#",
       case when passed then 'PASS' else 'FAIL' end as result,
       name, detail
from smoke_results order by ord;
\echo '===================================================='

-- Fail the script (nonzero exit) if any check is red.
\set ON_ERROR_STOP on
do $$
declare n int;
begin
  select count(*) into n from smoke_results where not passed;
  if n > 0 then
    raise exception 'SMOKE TEST FAILED: % check(s) red', n;
  end if;
end $$;
\echo 'ALL SMOKE CHECKS PASSED'
