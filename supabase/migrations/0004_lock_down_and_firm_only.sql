-- Firm-internal tool: only firm staff authenticate. Lock the SECURITY DEFINER write RPCs
-- to the backend (service_role) so an authenticated session cannot write into an arbitrary
-- entity through PostgREST, and ensure the anon role reaches nothing. Also harden the
-- double-entry balance trigger to survive posting DELETEs (future JE editing).
--
-- Apply with the Supabase CLI so the plpgsql body of assert_txn_balanced() actually lands.

-- write RPCs: backend (service_role) only
revoke all on function commit_transaction(uuid, date, text, text, txn_source, txn_status, text, uuid, uuid, jsonb) from public;
grant execute on function commit_transaction(uuid, date, text, text, txn_source, txn_status, text, uuid, uuid, jsonb) to service_role;
revoke all on function clear_posting(uuid, uuid, uuid, date, uuid) from public;
grant execute on function clear_posting(uuid, uuid, uuid, date, uuid) to service_role;

-- IMPORTANT: `revoke ... from public` is necessary but NOT sufficient. Supabase's default
-- privileges (ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated,
-- service_role) grant EXECUTE *directly* to authenticated on functions created by postgres,
-- and a direct grant is not removed by revoking from PUBLIC. Without the lines below an
-- authenticated staff session could still call these SECURITY DEFINER RPCs against ANY
-- entity through PostgREST. Revoke the direct grants too (anon is also covered by the
-- firm-only block further down; included here for defense-in-depth on these two functions).
revoke all on function commit_transaction(uuid, date, text, text, txn_source, txn_status, text, uuid, uuid, jsonb) from anon, authenticated;
revoke all on function clear_posting(uuid, uuid, uuid, date, uuid) from anon, authenticated;

-- firm-only: the anonymous/public role reaches nothing
revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Harden the balance guardrail for INSERT/UPDATE/DELETE on postings. On DELETE there is no
-- NEW row, so resolve the transaction from coalesce(new, old). A transaction's remaining
-- postings must still net to zero (an empty set nets to zero, allowing full-txn deletion).
create or replace function assert_txn_balanced()
returns trigger language plpgsql as $$
declare
  v_txn uuid := coalesce(new.transaction_id, old.transaction_id);
  s numeric(14,2);
begin
  select coalesce(sum(amount),0) into s from postings where transaction_id = v_txn;
  if abs(s) > 0.005 then
    raise exception 'Transaction % does not balance: residual %', v_txn, s;
  end if;
  return null;
end $$;

drop trigger if exists trg_txn_balanced on postings;
create constraint trigger trg_txn_balanced
  after insert or update or delete on postings
  deferrable initially deferred
  for each row execute function assert_txn_balanced();
