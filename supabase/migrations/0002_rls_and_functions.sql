-- RLS helpers, policies, and the double-entry balance trigger.
-- NOTE: apply with the Supabase CLI (or paste the plpgsql blocks manually in the SQL
-- editor). Lovable's migration runner silently skips `LANGUAGE plpgsql` bodies, which
-- would drop user_entities()/has_role()/assert_txn_balanced() and leave the DB unguarded.

-- caller's entity set; SECURITY DEFINER avoids recursive policy eval on memberships
create or replace function user_entities()
returns setof uuid language sql security definer stable
set search_path = public as $$
  select entity_id from memberships where user_id = auth.uid()
$$;

create or replace function has_role(e uuid, r member_role)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from memberships
    where user_id = auth.uid() and entity_id = e
      and (role = r or role = 'admin')
  )
$$;

-- enable RLS on every entity-scoped table
do $$
declare t text;
begin
  foreach t in array array[
    'entities','memberships','accounts','classes','bank_accounts',
    'import_batches','transactions','postings','statement_lines',
    'rules','balance_assertions','reconciliations','period_locks','audit_log'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- entities keyed by id; memberships by the calling user; everything else by entity_id
create policy ent_read on entities    for select using (id in (select user_entities()));
create policy mem_read on memberships for select using (user_id = auth.uid());

create policy acc_read   on accounts            for select using (entity_id in (select user_entities()));
create policy cls_read   on classes             for select using (entity_id in (select user_entities()));
create policy bank_read  on bank_accounts       for select using (entity_id in (select user_entities()));
create policy ib_read    on import_batches      for select using (entity_id in (select user_entities()));
create policy txn_read   on transactions        for select using (entity_id in (select user_entities()));
create policy post_read  on postings            for select using (entity_id in (select user_entities()));
create policy sl_read    on statement_lines     for select using (entity_id in (select user_entities()));
create policy rule_read  on rules               for select using (entity_id in (select user_entities()));
create policy ba_read    on balance_assertions  for select using (entity_id in (select user_entities()));
create policy rec_read   on reconciliations     for select using (entity_id in (select user_entities()));
create policy lock_read  on period_locks        for select using (entity_id in (select user_entities()));
create policy audit_read on audit_log           for select using (entity_id in (select user_entities()));

-- Writes happen via the service-role Node service, which BYPASSES RLS; the service must
-- scope entity_id on every query. The few client-side mutations we allow are gated by role:
-- posting, locking, and rule edits require reviewer/admin (has_role implies admin).
create policy rule_write on rules
  for all using (has_role(entity_id, 'reviewer'))
  with check (has_role(entity_id, 'reviewer'));
create policy lock_write on period_locks
  for all using (has_role(entity_id, 'reviewer'))
  with check (has_role(entity_id, 'reviewer'));

-- double-entry guardrail: a transaction's postings must net to zero (within tolerance)
create or replace function assert_txn_balanced()
returns trigger language plpgsql as $$
declare s numeric(14,2);
begin
  select coalesce(sum(amount),0) into s
  from postings where transaction_id = new.transaction_id;
  if abs(s) > 0.005 then
    raise exception 'Transaction % does not balance: residual %', new.transaction_id, s;
  end if;
  return new;
end $$;

create constraint trigger trg_txn_balanced
  after insert or update on postings
  deferrable initially deferred
  for each row execute function assert_txn_balanced();
