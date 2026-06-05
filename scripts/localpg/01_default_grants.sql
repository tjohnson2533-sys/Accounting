-- Emulates Supabase's default privileges, which grant broad access on the public schema
-- to anon/authenticated/service_role (ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS
-- TO anon, authenticated, service_role, etc.). Apply AFTER the table/function migrations
-- and BEFORE 0004 so that 0004's lockdown is a genuine *removal* of pre-existing grants —
-- this is what makes the "authenticated cannot execute the write RPCs" smoke check
-- meaningful rather than trivially true.
grant usage  on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;
