# LedgerPro — Build Doc

A cash-basis, register-style write-up engine for small bookkeeping clients. Excel is a dumb import pipe; the app owns categorization, reconciliation, and reporting. Double-entry under the hood; no A/R or A/P subledgers, no accruals.

-----

## 1. Decisions locked (the design log)

|#             |Decision                                                          |Consequence                                                                                                                                |
|--------------|------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
|Recognition   |**Cash basis**                                                    |Recognition = cash movement. No AR/AP, no accruals. Still double-entry internally.                                                         |
|Recon style   |**Register-style, two-sided**                                     |Two data sources: book entries (what you wrote/made) and statement lines (what cleared). Recon matches them; outstanding items are tracked.|
|Stack         |**Supabase (Postgres + RLS + Storage + Auth) + thin Node service**|Client reads go direct to Supabase under RLS; all posting/matching/JE logic runs in the Node service inside DB transactions.               |
|Import        |**Two-tab Excel, two fully independent lists**                    |Book tab and Statement tab each stand alone. The importer matches them; it does not assume one is a subset of the other.                   |
|Categorization|**App owns it, via a per-client rules engine**                    |Excel carries no GL codes. Description drives categorization. Rules are the single source of truth and compound in value across months.    |
|Manual JEs    |**In-app only**                                                   |Depreciation, payroll allocations, reclasses never touch Excel.                                                                            |
|Bank rec      |**In-app Bank Rec tab**                                           |Classic tie-out, computed from a per-posting cleared flag + a per-statement balance assertion.                                             |

### The double-entry trap this design avoids

A physical check is a **book** event (Dr expense / Cr cash, dated when written, cash leg uncleared). The same check later appears as a **statement** line. If both created transactions, every check would be double-counted. So a statement line **never creates a transaction when it matches a book entry** — it *clears* the existing entry. Statement lines only create transactions when they match nothing (bank-only items: fees, interest, ACH).

-----

## 2. Architecture

```
React (client)  ──direct reads──▶  Supabase Postgres   (RLS enforces tenant isolation)
     │                                   ▲
     │ mutations / posting / import      │ DB transactions
     ▼                                   │
  Node service  ───────────────────────-┘
  (double-entry posting, Excel parse, matching, JE gen, payroll)
  Supabase Storage  ◀── source scans + uploaded .xlsx (immutable, per import batch)
```

**Security posture.** Tenant isolation is enforced **at the database** with Postgres RLS, not in app code — one client seeing another’s books is the catastrophic failure for a firm, and DB-level policies you can’t forget to apply are safer than per-query checks. **Caveat:** the Node service connecting with the service-role key *bypasses* RLS, so every mutation path in Node must scope `entity_id` explicitly. RLS is defense-in-depth, not a free pass once a service-role backend exists.

**Storage / audit.** Both artifacts — the source bank scan/PDF and the exact uploaded `.xlsx` — are archived immutably and linked to the import batch. The audit trail must answer “where did this number come from” back to the source document, not stop at “imported a spreadsheet.”

-----

## 3. Data model (PostgreSQL)

Sign convention for `postings.amount`: **positive = debit, negative = credit**, and the postings of a transaction must sum to zero (within tolerance). A deposit into the bank = Dr cash (+) / Cr income (−).

```sql
-- ===== Tenancy & access =====
create type member_role as enum ('preparer','reviewer','admin');

create table entities (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  fiscal_year_end date,
  basis         text not null default 'cash',
  status        text not null default 'active',
  created_at    timestamptz not null default now()
);

create table memberships (
  user_id   uuid not null references auth.users(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  role      member_role not null default 'preparer',
  primary key (user_id, entity_id)
);

-- ===== Chart of accounts & dimensions =====
create type account_type as enum ('asset','liability','equity','income','expense');

create table accounts (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entities(id) on delete cascade,
  code       text not null,
  name       text not null,
  type       account_type not null,
  is_bank    boolean not null default false,
  parent_id  uuid references accounts(id),
  active     boolean not null default true,
  opened_on  date,
  closed_on  date,
  unique (entity_id, code)
);

create table classes (              -- fund / department dimension (municipalities)
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entities(id) on delete cascade,
  name       text not null,
  parent_id  uuid references classes(id),
  active     boolean not null default true,
  unique (entity_id, name)
);

create table bank_accounts (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entities(id) on delete cascade,
  account_id  uuid not null references accounts(id),   -- the GL cash account
  name        text not null,
  last4       text,
  active      boolean not null default true
);

-- ===== Import provenance =====
create type import_status as enum ('uploaded','validated','matched','committed','rejected');

create table import_batches (
  id                          uuid primary key default gen_random_uuid(),
  entity_id                   uuid not null references entities(id) on delete cascade,
  bank_account_id             uuid not null references bank_accounts(id),
  uploaded_by                 uuid not null references auth.users(id),
  source_xlsx_path            text,                    -- Supabase Storage key
  source_statement_path       text,                    -- the scan/PDF
  template_version            text not null,
  statement_period_start      date not null,
  statement_period_end        date not null,
  statement_beginning_balance numeric(14,2) not null,
  statement_ending_balance    numeric(14,2) not null,
  status                      import_status not null default 'uploaded',
  created_at                  timestamptz not null default now()
);

-- ===== Transactions & postings =====
create type txn_source as enum ('book_import','manual_je','bank_only');
create type txn_status as enum ('imported','categorized','reviewed','posted');

create table transactions (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entities(id) on delete cascade,
  txn_date        date not null,
  payee           text,
  description     text,
  source          txn_source not null,
  import_batch_id uuid references import_batches(id),
  status          txn_status not null default 'imported',
  content_hash    text not null,                       -- dedup key
  tags            text[]  not null default '{}',
  links           uuid[]  not null default '{}',       -- chain related txns (interfund pairs, etc.)
  meta            jsonb   not null default '{}',
  created_by      uuid references auth.users(id),
  reviewed_by     uuid references auth.users(id),
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (entity_id, content_hash)
);

create table postings (
  id                uuid primary key default gen_random_uuid(),
  transaction_id    uuid not null references transactions(id) on delete cascade,
  entity_id         uuid not null references entities(id) on delete cascade,  -- denormalized for RLS
  account_id        uuid not null references accounts(id),
  class_id          uuid references classes(id),
  amount            numeric(14,2) not null,            -- + debit / − credit
  -- reconciliation state (meaningful on the bank/cash leg):
  cleared           boolean not null default false,
  cleared_date      date,
  cleared_by        uuid references auth.users(id),
  statement_line_id uuid,                              -- the line that cleared it
  check_number      text,
  meta              jsonb not null default '{}'
);
create index on postings (entity_id, account_id);
create index on postings (transaction_id);
create index on postings (account_id, cleared) where cleared = false;  -- standing uncleared set

-- ===== Statement lines (the cleared facts / evidence) =====
create type line_match as enum ('unmatched','matched','bank_only_booked','ignored');

create table statement_lines (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entities(id) on delete cascade,
  import_batch_id   uuid not null references import_batches(id) on delete cascade,
  bank_account_id   uuid not null references bank_accounts(id),
  line_date         date not null,
  description       text not null,
  check_number      text,
  amount            numeric(14,2) not null,            -- + money in / − money out
  match_status      line_match not null default 'unmatched',
  matched_posting_id uuid references postings(id),
  created_at        timestamptz not null default now()
);
create index on statement_lines (entity_id, match_status);

-- ===== Categorization rules =====
create type rule_match as enum ('contains','regex','exact','check_range');

create table rules (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entities(id) on delete cascade,
  priority   int not null default 100,
  match_type rule_match not null,
  pattern    text,
  check_low  int,
  check_high int,
  account_id uuid not null references accounts(id),
  class_id   uuid references classes(id),
  active     boolean not null default true,
  hit_count  int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ===== Balance assertions (beancount's Balance / Pad) =====
create type assertion_source as enum ('statement','opening','manual');

create table balance_assertions (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entities(id) on delete cascade,
  account_id      uuid not null references accounts(id),
  assert_date     date not null,        -- holds at START of this date
  amount          numeric(14,2) not null,
  tolerance       numeric(14,2) not null default 0.005,
  diff_amount     numeric(14,2),        -- null = passed; set on failure
  source          assertion_source not null,
  import_batch_id uuid references import_batches(id)
);

-- ===== Reconciliation record =====
create type recon_status as enum ('in_progress','reconciled');

create table reconciliations (
  id                        uuid primary key default gen_random_uuid(),
  entity_id                 uuid not null references entities(id) on delete cascade,
  bank_account_id           uuid not null references bank_accounts(id),
  import_batch_id           uuid not null references import_batches(id),
  statement_ending_balance  numeric(14,2) not null,
  computed_cleared_balance  numeric(14,2) not null,
  outstanding_total         numeric(14,2) not null,
  in_transit_total          numeric(14,2) not null,
  book_balance              numeric(14,2) not null,
  difference                numeric(14,2) not null,
  status                    recon_status not null default 'in_progress',
  reconciled_by             uuid references auth.users(id),
  reconciled_at             timestamptz
);

-- ===== Period lock & audit =====
create table period_locks (
  entity_id      uuid primary key references entities(id) on delete cascade,
  locked_through date not null,
  locked_by      uuid references auth.users(id),
  locked_at      timestamptz not null default now()
);

create table audit_log (
  id         bigserial primary key,
  entity_id  uuid not null,
  actor      uuid,
  action     text not null,
  table_name text,
  row_id     text,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);
```

**RLS** (see scaffold for the policy bodies): every table carries `entity_id`; the read policy is “the row’s entity is one of mine.” A `SECURITY DEFINER` helper `user_entities()` returns the caller’s entity set and is used in policies to avoid recursive evaluation against `memberships`. Posting, locking, and rule edits additionally require `reviewer`/`admin`.

-----

## 4. Import → match → commit pipeline

### Validator battery (accumulate ALL errors; never fail fast)

Run on upload, return every problem at once with tab + row references so a staffer fixes the sheet in one pass.

- **Setup:** `template_version` supported; client, bank account, period dates, beginning + ending balance present; **statement self-check** ties: `beginning + Σcredits − Σdebits = ending` within tolerance.
- **Per row (both tabs):** exactly one of Payment/Deposit; valid date; check # present when Type = Check; amount > 0.
- **On commit (each generated transaction):** postings sum to zero within tolerance; account exists and is active on the date; class valid; **period not locked** (`txn_date > locked_through`).

### Dedup

Before creating any transaction, compute `content_hash = hash(entity_id, txn_date, signed_amount, normalized_payee, check_number)`. Skip if the hash already exists. This makes overlapping re-uploads idempotent — the Excel analog of a bank’s FITID, which the spreadsheet path doesn’t provide.

### Matching (the heart of the two-list model)

Load the **standing set of uncleared book postings** for the bank account — *across all periods*, not just this batch. A check written in December and outstanding at 12/31 clears on the January statement and must match the December book entry, not spawn a duplicate.

For each statement line:

1. **Check number present** → exact match to an uncleared book posting with the same `check_number` (and amount within tolerance). Found → set posting `cleared = true`, `cleared_date = line_date`, `statement_line_id`; line → `matched`.
1. **No check number** → candidates = uncleared book postings with equal signed amount and `|line_date − book_date| ≤ 5 days`. Exactly one → clear it. Multiple → leave the line `unmatched` and surface it for manual pick in the Bank Rec tab.
1. **No match** → **bank-only item**. Generate a transaction (cash leg + a suggested offset account from the rules engine), mark line `bank_only_booked`, flag for review.

After matching, write a `balance_assertions` row (`source='statement'`, `assert_date = period_end + 1`, `amount = statement_ending_balance`).

Remaining uncleared book postings as of `period_end`:

- credit-to-cash that hasn’t cleared → **outstanding check**
- debit-to-cash that hasn’t cleared → **deposit in transit**

-----

## 5. Bank Rec tab (the tie-out)

Computed entirely from the cleared flag + the balance assertion — nothing new to engineer:

```
  Statement ending balance            ← balance_assertions (source='statement')
+ Deposits in transit                 ← uncleared debit-to-cash book postings ≤ period_end
− Outstanding checks                  ← uncleared credit-to-cash book postings ≤ period_end
= Adjusted bank balance
  must equal  Book cash balance       ← Σ postings on the cash account (status=posted)
  difference  → 0 (± tolerance)  ⇒  reconciliation 'reconciled' ⇒ period can lock
```

The reviewer’s job in the tab: book the unmatched bank-only items (fees/interest/ACH) — the things they didn’t know to enter — resolve any multi-candidate matches, then confirm the difference is zero and lock the period.

-----

## 6. Categorization engine (composable stages)

Modeled on beancount’s plugin pipeline — each stage is `(transactions) → (transactions, errors)`:

1. **Rules apply** — normalize payee/memo, then evaluate `rules` by `priority`. `check_range` rules key on check-number bands; `contains`/`regex`/`exact` on normalized description. First hit assigns `account_id` (+ `class_id`); `hit_count++`.
1. **Suggest** — for the unmatched tail, nearest-neighbor against this client’s prior categorizations (and optionally an LLM call). Surface as a suggestion, not an auto-post.
1. **Learn** — when a reviewer accepts/corrects a suggestion, write a new `rule`. Month N+1 gets faster automatically. This learning loop is the real leverage across ~100 clients.

Normalization matters: bank descriptions are noisy (`SQ *COFFEE 0123`, trailing store numbers) — strip/standardize before matching.

-----

## 7. Reporting

All SQL aggregations over `postings` joined to `accounts`, filtered to `status='posted'` and a date range — Postgres does this; no query language needed.

- Cash-basis **P&L**, **Balance Sheet**, **Trial Balance**, **General Ledger** (drill to posting → import batch → source document).
- **Comparative** (period-over-period) and by `class` (fund/department).
- Export to PDF/Excel; client package.
- Optional later: an LLM “what changed vs last month” narrative over the comparative figures.

-----

## 8. Build sequence

|Phase             |Scope                                                                                                                                               |Proves                                           |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------|
|**0**             |Schema + RLS + auth + COA/classes + manual JE (with elided-posting auto-balance) + GL + cash-basis P&L                                              |The core double-entry ledger and tenant isolation|
|**1**             |Storage bucket + two-tab parser → canonical schema + validator battery + content-hash dedup + matching engine + Bank Rec tab + tie-out + period lock|Automated data entry + real reconciliation       |
|**2**             |Rules engine + categorization UI + suggestions + learning loop                                                                                      |The payoff across ~100 clients                   |
|**3**             |Payroll summary → JE generation (per-provider parsers)                                                                                              |The Converse pattern, generalized                |
|**4**             |Review dashboard (prior-period compare, suspense queue, anomaly flags) + comparative reports + client package + exports                             |Reviewer throughput                              |
|**5** *(optional)*|PDF → filled-template extraction (Claude-powered) replacing manual keying; Plaid for big-bank clients                                               |Eliminates the last manual step                  |

Note on Phase 5: decoupling extraction (PDF → template) from the app is what lets you automate keying later **without touching the app** — the app keeps accepting the same canonical schema. That clean seam is the reason the Excel-as-contract design is worth it even while you key by hand at first.

-----

## 9. Deliberately skipped

- **Plain-text format / DSL parser** — Postgres + RLS is the right multi-tenant store; emulate beancount’s *model*, not its file format.
- **A query language (BQL)** — Postgres SQL covers reporting.
- **Commodity / lot / cost-basis / booking-method / inventory engine** — that’s investment lot tracking; cash-basis service and municipal clients don’t need it (~half of beancount’s code).
- **A/R & A/P subledgers, accruals** — out of scope for cash basis by definition.
- **Plaid / live bank feeds in v1** — weak coverage for small Louisiana banks and the weight of holding live credentials aren’t worth it when one upload per client per month gets you ~95% there. Revisit in Phase 5 for big-bank clients only.