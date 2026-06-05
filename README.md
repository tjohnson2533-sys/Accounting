# LedgerPro

A cash-basis, register-style write-up engine for a bookkeeping firm. Excel is a dumb import
pipe; the app owns categorization, reconciliation, and reporting, with double-entry under the
hood. See [`LedgerPro_Build_Doc.md`](./LedgerPro_Build_Doc.md) for the full design.

**This repo delivers Phase 0 (core ledger + tenant isolation) and Phase 1 (two-list import +
reconciliation).** Phases 2–5 (rules engine, payroll JEs, review dashboard, PDF extraction) are
scoped in the Build Doc but not yet built.

## Stack

- **Supabase** (Postgres + RLS + Storage + Auth) — tenant isolation enforced at the database.
- **Node + TypeScript service** (`packages/server`) — all posting/import/matching/recon logic,
  inside DB transactions. Connects with the service-role key (which **bypasses RLS**), so every
  query scopes `entity_id` explicitly.
- **React + TypeScript** (`packages/web`) — reads go direct to Supabase under RLS; mutations go
  through the service.

## Layout

```
supabase/migrations/   0001 schema · 0002 RLS + balance trigger · 0003 commit/clear RPCs
packages/server/src/   ledger/ import/ recon/ reports/ routes/ + db.ts
packages/web/src/      pages/{Accounts,JournalEntry,Import,BankRec,Reports}
templates/             LedgerPro_Import_Template_v1.xlsx (the canonical import contract)
scripts/seed_demo.mjs  demo client + users + chart of accounts
```

## Security posture (firm-internal)

This is a **firm-internal** tool: only firm staff (preparer / reviewer / admin) ever
authenticate. "Entities" are client books — no client or customer logs in. Self-registration
is disabled (`config.toml`: `enable_signup=false`, `enable_anonymous_sign_ins=false`); staff
accounts are provisioned by an admin.

Tenant isolation between client books is enforced at the database with **RLS** (every table is
scoped to the caller's entities). The Node service connects with the **service-role key, which
bypasses RLS**, so it must scope `entity_id` on every query, and the **write RPCs**
(`commit_transaction`, `clear_posting`) are restricted to `service_role` — no front-end role can
call them.

> **Gotcha that bit us — `revoke … from public` is not enough.** Supabase's default privileges
> grant `EXECUTE` *directly* to `authenticated` on functions created by `postgres`
> (`ALTER DEFAULT PRIVILEGES … GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role`).
> Revoking from `PUBLIC` does **not** remove a direct grant to `authenticated`, so an
> authenticated staff session could otherwise still call these `SECURITY DEFINER` RPCs against
> **any** entity through PostgREST. Migration `0004` therefore also `revoke`s execute from
> `anon, authenticated` explicitly. This is asserted by the smoke test below (checks #30/#31).

### Smoke test

`scripts/smoke_rls.sql` proves, against a live database: cross-entity isolation (two staff in two
entities each see only their own rows), the deferred balance trigger rejecting an unbalanced
transaction and accepting a balanced one, and `authenticated`/`anon` being unable to execute the
write RPCs. It prints PASS/FAIL per check and exits nonzero on any failure.

```bash
# Plain Postgres (no Docker) — applies the migrations with the Supabase primitives emulated:
createdb ledgerpro
PSQL_DSN="postgresql://postgres:postgres@localhost:5432/ledgerpro" scripts/localpg/run_smoke.sh

# Against a real Supabase local stack:
supabase start && supabase db reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -f scripts/smoke_rls.sql
```

CI runs this on every push/PR (`.github/workflows/ci.yml`, the **rls-smoke** job) alongside the
unit tests and typecheck. The `scripts/localpg/*` helpers emulate the Supabase platform
primitives (roles, `auth` schema, `auth.uid()`, default privileges) so the smoke test — and the
`0004` lockdown in particular — can be exercised on a bare Postgres without the Docker stack.

## Run it locally

```bash
npm install

# 1. Database (Supabase CLI — NOT Lovable's runner; it skips plpgsql bodies)
supabase start
supabase db reset            # applies migrations 0001–0003
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed_demo.mjs

# 2. Service
cp packages/server/.env.example packages/server/.env   # fill in URL + service-role key
npm run dev:server

# 3. Web
cp packages/web/.env.example packages/web/.env          # fill in URL + anon key + server URL
npm run dev:web
```

## Test

```bash
npm test            # server unit suite (pure ledger/import/match/recon/report logic)
npm run typecheck   # both packages
```

The suite covers: autobalance rules, the validator battery (accumulates all errors), content-hash
dedup, the book↔statement matcher (check#, date-window, multi-candidate, bank-only, the
December-check-clears-in-January case), the bank-rec tie-out, and the cash-basis reports.

## End-to-end flow

Import the v1 template on the **Import** page → resolve any validation errors → **Bank Rec**
computes the tie-out → reconcile (locks the period) → **Reports** shows posted Trial Balance /
P&L / Balance Sheet. Re-uploading an overlapping workbook is idempotent (content-hash dedup).
