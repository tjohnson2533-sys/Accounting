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
