#!/usr/bin/env bash
# Apply the LedgerPro migrations onto a plain PostgreSQL database (with the Supabase
# primitives emulated) and run the RLS + lockdown smoke test. Used by CI and for local
# verification without the full Supabase Docker stack.
#
#   PSQL_DSN="postgresql://postgres:postgres@localhost:5432/ledgerpro" scripts/localpg/run_smoke.sh
#
# Order matters: bootstrap -> schema/RLS/functions -> Supabase default-privilege emulation
# -> 0004 lockdown. 0004 must run AFTER the default grants so the revokes actually remove
# pre-existing access (see 01_default_grants.sql).
set -euo pipefail

DSN="${PSQL_DSN:?set PSQL_DSN to the target Postgres connection string}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
apply() { echo "  apply $1"; psql "$DSN" -v ON_ERROR_STOP=1 -q -f "$ROOT/$1"; }

echo "Applying migrations to $DSN"
apply scripts/localpg/00_bootstrap.sql
apply supabase/migrations/0001_schema.sql
apply supabase/migrations/0002_rls_and_functions.sql
apply supabase/migrations/0003_functions.sql
apply scripts/localpg/01_default_grants.sql
apply supabase/migrations/0004_lock_down_and_firm_only.sql

echo "Running RLS + lockdown smoke test"
# smoke_rls.sql manages ON_ERROR_STOP itself and exits nonzero on any FAIL.
psql "$DSN" -f "$ROOT/scripts/smoke_rls.sql"
