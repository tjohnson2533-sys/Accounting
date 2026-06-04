-- Atomic transaction commit. supabase-js issues one REST call per statement and cannot
-- wrap multi-row inserts in a single DB transaction; this RPC does. It also lets the
-- deferred balance trigger (trg_txn_balanced) fire at the right boundary and enforces the
-- period lock and content-hash dedup server-side.
--
-- Postings must arrive already balanced and amount-resolved (Node runs autobalance first).
-- Returns the new transaction id, or NULL when the content_hash already exists (dedup skip).

create or replace function commit_transaction(
  p_entity_id      uuid,
  p_txn_date       date,
  p_payee          text,
  p_description    text,
  p_source         txn_source,
  p_status         txn_status,
  p_content_hash   text,
  p_import_batch_id uuid,
  p_created_by     uuid,
  p_postings       jsonb            -- [{account_id, class_id, amount, check_number, meta}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked date;
  v_txn_id uuid;
  v_posting jsonb;
begin
  -- period lock
  select locked_through into v_locked from period_locks where entity_id = p_entity_id;
  if v_locked is not null and p_txn_date <= v_locked then
    raise exception 'Period is locked through %; cannot post on %', v_locked, p_txn_date;
  end if;

  -- dedup: skip if this content_hash already exists for the entity
  insert into transactions (
    entity_id, txn_date, payee, description, source, status,
    content_hash, import_batch_id, created_by
  ) values (
    p_entity_id, p_txn_date, p_payee, p_description, p_source, coalesce(p_status,'imported'),
    p_content_hash, p_import_batch_id, p_created_by
  )
  on conflict (entity_id, content_hash) do nothing
  returning id into v_txn_id;

  if v_txn_id is null then
    return null;  -- duplicate, idempotent skip
  end if;

  for v_posting in select * from jsonb_array_elements(p_postings) loop
    insert into postings (
      transaction_id, entity_id, account_id, class_id, amount, check_number, meta
    ) values (
      v_txn_id,
      p_entity_id,
      (v_posting->>'account_id')::uuid,
      nullif(v_posting->>'class_id','')::uuid,
      (v_posting->>'amount')::numeric,
      nullif(v_posting->>'check_number',''),
      coalesce(v_posting->'meta','{}'::jsonb)
    );
  end loop;

  insert into audit_log (entity_id, actor, action, table_name, row_id, after)
  values (p_entity_id, p_created_by, 'commit_transaction', 'transactions', v_txn_id::text,
          jsonb_build_object('source', p_source, 'content_hash', p_content_hash));

  return v_txn_id;
end $$;

-- Clear a book posting against a statement line (reconciliation match).
create or replace function clear_posting(
  p_entity_id  uuid,
  p_posting_id uuid,
  p_line_id    uuid,
  p_cleared_date date,
  p_cleared_by uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update postings
     set cleared = true, cleared_date = p_cleared_date,
         cleared_by = p_cleared_by, statement_line_id = p_line_id
   where id = p_posting_id and entity_id = p_entity_id;

  update statement_lines
     set match_status = 'matched', matched_posting_id = p_posting_id
   where id = p_line_id and entity_id = p_entity_id;
end $$;
