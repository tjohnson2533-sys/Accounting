-- LedgerPro schema (Build Doc §3, verbatim).
-- Sign convention for postings.amount: positive = debit, negative = credit;
-- the postings of a transaction must sum to zero within tolerance (0.005).

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
