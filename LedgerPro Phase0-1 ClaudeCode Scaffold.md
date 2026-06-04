# LedgerPro — Claude Code Scaffold (Phase 0 → Phase 1)

> Feed this to Claude Code as a prompt file. It builds the core ledger (Phase 0) and the two-list import + reconciliation engine (Phase 1). Full schema rationale and algorithms live in `LedgerPro_Build_Doc.md`; this file is the executable plan.

## Project context

- **Product:** cash-basis, register-style bookkeeping app for a tax/accounting firm with ~100 monthly clients. Excel is a dumb import pipe; the app owns categorization, reconciliation, and reporting. Double-entry internally; no A/R or A/P, no accruals.
- **Stack:** React (Vite) + TypeScript frontend · Supabase (Postgres + RLS + Storage + Auth) · a Node + TypeScript service for posting/import/matching/JE logic. Client reads go direct to Supabase under RLS; all mutations go through the Node service, which connects with the service-role key and **must scope `entity_id` on every query** (service role bypasses RLS).
- **Sign convention:** `postings.amount` is `+` debit / `−` credit; postings of a transaction sum to zero within tolerance. Deposit into bank = Dr cash (+) / Cr income (−).

## Repo structure to scaffold

```
ledgerpro/
  supabase/
    migrations/
      0001_schema.sql          # tables from Build Doc §3 (verbatim)
      0002_rls_and_functions.sql  # provided in full below
  packages/
    server/                    # Node + TS service
      src/
        db.ts                  # service-role client; entity-scoped query helpers
        ledger/post.ts         # build + commit balanced transactions
        ledger/autobalance.ts  # infer the single elided posting
        import/parseWorkbook.ts# two-tab xlsx → canonical rows
        import/validate.ts     # validator battery (accumulate errors)
        import/dedup.ts        # content_hash
        import/match.ts        # standing-set book↔statement matcher
        recon/tieout.ts        # outstanding / in-transit / difference
        reports/cashbasis.ts   # P&L, BS, TB, GL queries
      src/routes/              # thin HTTP handlers
    web/                       # React app
      src/pages/{Accounts,JournalEntry,Import,BankRec,Reports}.tsx
```

## Conventions & gotchas

- Migrations are plain SQL in `supabase/migrations`. **If you run them through Lovable’s migration runner, it silently skips PL/pgSQL function bodies** — paste every `CREATE FUNCTION … LANGUAGE plpgsql` block manually via Supabase’s SQL editor, or apply migrations with the Supabase CLI. The RLS helper and the balance trigger below are exactly these.
- Identity is `auth.uid()` (Supabase Auth), not email.
- Money is `numeric(14,2)`; never floats. Tolerance for balance/tie-out checks is `0.005`.
- Push via GitHub Desktop.

-----

## PHASE 0 — core ledger

### 0.1 Migration `0001_schema.sql`

Create the tables exactly as in **Build Doc §3** (entities, memberships, accounts, classes, bank_accounts, import_batches, transactions, postings, statement_lines, rules, balance_assertions, reconciliations, period_locks, audit_log) with the enums and indexes shown there.

### 0.2 Migration `0002_rls_and_functions.sql` (full)

```sql
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

-- enable RLS + read policy on every entity-scoped table
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

-- entities keyed by id; everything else by entity_id
create policy ent_read on entities for select using (id in (select user_entities()));
create policy mem_read on memberships for select using (user_id = auth.uid());

-- generic read policies (repeat per table or generate)
create policy acc_read   on accounts            for select using (entity_id in (select user_entities()));
create policy cls_read   on classes             for select using (entity_id in (select user_entities()));
create policy bank_read  on bank_accounts       for select using (entity_id in (select user_entities()));
create policy ib_read    on import_batches       for select using (entity_id in (select user_entities()));
create policy txn_read   on transactions        for select using (entity_id in (select user_entities()));
create policy post_read  on postings            for select using (entity_id in (select user_entities()));
create policy sl_read    on statement_lines     for select using (entity_id in (select user_entities()));
create policy rule_read  on rules               for select using (entity_id in (select user_entities()));
create policy ba_read    on balance_assertions  for select using (entity_id in (select user_entities()));
create policy rec_read   on reconciliations     for select using (entity_id in (select user_entities()));
create policy lock_read  on period_locks        for select using (entity_id in (select user_entities()));
create policy audit_read on audit_log           for select using (entity_id in (select user_entities()));
-- NOTE: writes happen via the service-role Node service, which bypasses RLS.
-- Client-side writes (if any) need explicit insert/update policies gated by has_role().

-- double-entry guardrail: a POSTED transaction's postings must net to zero
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
```

### 0.3 Server: ledger primitives

- `ledger/autobalance.ts` — given postings where one amount is omitted, compute the missing amount as `-(sum of the rest)`; reject if more than one is missing or the result exceeds tolerance. Used by manual JE entry and split deposits.
- `ledger/post.ts` — `commitTransaction({entity_id, date, payee, description, source, postings})`: open a DB transaction, insert `transactions` + `postings`, let the deferred trigger enforce balance, write `audit_log`. Reject if `date <= period_locks.locked_through`.

### 0.4 Web

- **Accounts** page: CRUD chart of accounts + classes.
- **Journal Entry** page: multi-line entry; running debit/credit totals; “balance” button calls `autobalance`; cannot save unless residual ≤ tolerance.
- Minimal **Reports**: GL listing + cash-basis P&L (see 1.6).

### Phase 0 acceptance

- A new user only sees entities they’re a member of (verify by querying as two different users).
- Posting an unbalanced JE fails at the DB; a balanced one succeeds and appears in the GL and P&L.
- Posting into a locked period fails.

-----

## PHASE 1 — two-list import + reconciliation

### 1.1 Storage

Create a private bucket `imports`. On upload, store the `.xlsx` and the source statement scan; record their keys on `import_batches`. Never mutate stored files.

### 1.2 `import/parseWorkbook.ts`

Parse the v1 template (see `LedgerPro_Import_Template_v1.xlsx`):

- **Setup tab:** read `template_version`, client, bank account, period start/end, beginning + ending balance.
- **Book tab:** `Date, Type, Check #, Payee/Description, Payment, Deposit, Memo` → canonical book rows (signed amount = `Deposit − Payment`).
- **Statement tab:** `Date, Description, Check #, Payment, Deposit, Memo` → canonical statement rows (signed amount = `Deposit − Payment`).
  Reject unknown `template_version`.

### 1.3 `import/validate.ts` — battery, accumulate ALL errors

Return `{errors: [{tab,row,message}], warnings}` — never stop at the first.

- Setup present + supported version; **statement self-check** `beginning + Σ(statement credits) − Σ(statement debits) = ending` within tolerance.
- Per row: exactly one of Payment/Deposit; valid date; `Check #` present when Type = Check; amount > 0.
  Block commit if any error; surface the list in the Import UI keyed to tab+row.

### 1.4 `import/dedup.ts`

`content_hash = sha256(entity_id | txn_date | signed_amount | normalize(payee) | check_number)`. On commit, skip any book row whose hash already exists in `transactions` (idempotent re-upload).

### 1.5 `import/match.ts` — the matcher

1. Commit Book rows as `transactions` (`source='book_import'`, cash leg `cleared=false`, offset account left for the rules engine in Phase 2 — until then, post to a `Suspense` account).
1. Load the **standing set** of uncleared cash-leg postings for the bank account across **all** periods.
1. For each Statement row:
- **check # present** → exact match on `check_number` (+ amount within tolerance) → clear posting (`cleared=true, cleared_date=line_date, statement_line_id`), line `matched`.
- **no check #** → candidates = uncleared postings, equal signed amount, `|date diff| ≤ 5d`; exactly one → clear; multiple → leave `unmatched` for manual pick.
- **no match** → create a `bank_only` transaction (cash leg + Suspense offset), line `bank_only_booked`.
1. Insert `balance_assertions` (`source='statement'`, `assert_date = period_end + 1`, `amount = ending`).
1. Set batch `status='matched'`.

### 1.6 `recon/tieout.ts` + Bank Rec page

Compute and persist a `reconciliations` row:

```
deposits_in_transit = Σ uncleared cash-leg postings with amount > 0 and date <= period_end
outstanding_checks  = Σ uncleared cash-leg postings with amount < 0 and date <= period_end
adjusted_bank       = statement_ending + deposits_in_transit + outstanding_checks   -- (checks are negative)
book_balance        = Σ cash-leg postings (status='posted')
difference          = adjusted_bank - book_balance
```

**Bank Rec page** shows the tie-out, lists unmatched statement lines (book them → Suspense or chosen account) and multi-candidate matches (pick one). When `|difference| ≤ tolerance`, allow **Reconcile** → set `reconciliations.status='reconciled'` and advance `period_locks.locked_through` to `period_end`.

### 1.7 Reports

`reports/cashbasis.ts`: P&L, Balance Sheet, Trial Balance, GL — SQL over `postings ⋈ accounts` where `status='posted'` and date range; GL rows drill to posting → import_batch → source file.

### Phase 1 acceptance

- A check on the Book tab and its cleared line on the Statement tab produce **one** transaction with a cleared cash leg — not two.
- A December-written, December-Book check left uncleared appears as an **outstanding check**; importing the January statement that contains it clears it (no duplicate).
- A bank fee present only on the Statement tab becomes a bank-only transaction flagged for categorization.
- Re-uploading an overlapping workbook creates no duplicates.
- When the tie-out difference is zero, reconciling locks the period; posting back into it then fails.