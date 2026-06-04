# LedgerPro — Build Doc

A cash-basis, register-style write-up engine for small bookkeeping clients. Excel is a dumb import pipe; the app owns categorization, reconciliation, and reporting. Double-entry under the hood; no A/R or A/P subledgers, no accruals.

-----

## 1. Decisions locked (the design log)

| # | Decision | Consequence |
|---|----------|-------------|
| Recognition | **Cash basis** | Recognition = cash movement. No AR/AP, no accruals. Still double-entry internally. |
| Recon style | **Register-style, two-sided** | Two data sources: book entries (what you wrote/made) and statement lines (what cleared). Recon matches them; outstanding items are tracked. |
| Stack | **Supabase (Postgres + RLS + Storage + Auth) + thin Node service** | Client reads go direct to Supabase under RLS; all posting/matching/JE logic runs in the Node service inside DB transactions. |
| Import | **Two-tab Excel, two fully independent lists** | Book tab and Statement tab each stand alone. The importer matches them; it does not assume one is a subset of the other. |
| Categorization | **App owns it, via a per-client rules engine** | Excel carries no GL codes. Description drives categorization. Rules are the single source of truth and compound in value across months. |
| Manual JEs | **In-app only** | Depreciation, payroll allocations, reclasses never touch Excel. |
| Bank rec | **In-app Bank Rec tab** | Classic tie-out, computed from a per-posting cleared flag + a per-statement balance assertion. |

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

**Security posture.** Tenant isolation is enforced **at the database** with Postgres RLS, not in app code — one client seeing another's books is the catastrophic failure for a firm, and DB-level policies you can't forget to apply are safer than per-query checks. **Caveat:** the Node service connecting with the service-role key *bypasses* RLS, so every mutation path in Node must scope `entity_id` explicitly. RLS is defense-in-depth, not a free pass once a service-role backend exists.

**Storage / audit.** Both artifacts — the source bank scan/PDF and the exact uploaded `.xlsx` — are archived immutably and linked to the import batch. The audit trail must answer "where did this number come from" back to the source document, not stop at "imported a spreadsheet."

-----

## 3. Data model (PostgreSQL)

Sign convention for `postings.amount`: **positive = debit, negative = credit**, and the postings of a transaction must sum to zero (within tolerance). A deposit into the bank = Dr cash (+) / Cr income (−).

See `supabase/migrations/0001_schema.sql` for the authoritative DDL (reproduced verbatim from this section).

-----

## 4. Import → match → commit pipeline

### Validator battery (accumulate ALL errors; never fail fast)

Run on upload, return every problem at once with tab + row references so a staffer fixes the sheet in one pass.

- **Setup:** `template_version` supported; client, bank account, period dates, beginning + ending balance present; **statement self-check** ties: `beginning + Σcredits − Σdebits = ending` within tolerance.
- **Per row (both tabs):** exactly one of Payment/Deposit; valid date; check # present when Type = Check; amount > 0.
- **On commit (each generated transaction):** postings sum to zero within tolerance; account exists and is active on the date; class valid; **period not locked** (`txn_date > locked_through`).

### Dedup

Before creating any transaction, compute `content_hash = hash(entity_id, txn_date, signed_amount, normalized_payee, check_number)`. Skip if the hash already exists. This makes overlapping re-uploads idempotent — the Excel analog of a bank's FITID, which the spreadsheet path doesn't provide.

### Matching (the heart of the two-list model)

Load the **standing set of uncleared book postings** for the bank account — *across all periods*, not just this batch. A check written in December and outstanding at 12/31 clears on the January statement and must match the December book entry, not spawn a duplicate.

For each statement line:

1. **Check number present** → exact match to an uncleared book posting with the same `check_number` (and amount within tolerance). Found → set posting `cleared = true`, `cleared_date = line_date`, `statement_line_id`; line → `matched`.
2. **No check number** → candidates = uncleared book postings with equal signed amount and `|line_date − book_date| ≤ 5 days`. Exactly one → clear it. Multiple → leave the line `unmatched` and surface it for manual pick in the Bank Rec tab.
3. **No match** → **bank-only item**. Generate a transaction (cash leg + a suggested offset account from the rules engine), mark line `bank_only_booked`, flag for review.

After matching, write a `balance_assertions` row (`source='statement'`, `assert_date = period_end + 1`, `amount = statement_ending_balance`).

Remaining uncleared book postings as of `period_end`:

- credit-to-cash that hasn't cleared → **outstanding check**
- debit-to-cash that hasn't cleared → **deposit in transit**

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

The reviewer's job in the tab: book the unmatched bank-only items (fees/interest/ACH) — the things they didn't know to enter — resolve any multi-candidate matches, then confirm the difference is zero and lock the period.

-----

## 6. Categorization engine (composable stages)

Modeled on beancount's plugin pipeline — each stage is `(transactions) → (transactions, errors)`:

1. **Rules apply** — normalize payee/memo, then evaluate `rules` by `priority`. `check_range` rules key on check-number bands; `contains`/`regex`/`exact` on normalized description. First hit assigns `account_id` (+ `class_id`); `hit_count++`.
2. **Suggest** — for the unmatched tail, nearest-neighbor against this client's prior categorizations (and optionally an LLM call). Surface as a suggestion, not an auto-post.
3. **Learn** — when a reviewer accepts/corrects a suggestion, write a new `rule`. Month N+1 gets faster automatically. This learning loop is the real leverage across ~100 clients.

Normalization matters: bank descriptions are noisy (`SQ *COFFEE 0123`, trailing store numbers) — strip/standardize before matching.

-----

## 7. Reporting

All SQL aggregations over `postings` joined to `accounts`, filtered to `status='posted'` and a date range — Postgres does this; no query language needed.

- Cash-basis **P&L**, **Balance Sheet**, **Trial Balance**, **General Ledger** (drill to posting → import batch → source document).
- **Comparative** (period-over-period) and by `class` (fund/department).
- Export to PDF/Excel; client package.
- Optional later: an LLM "what changed vs last month" narrative over the comparative figures.

-----

## 8. Build sequence

| Phase | Scope | Proves |
|-------|-------|--------|
| **0** | Schema + RLS + auth + COA/classes + manual JE (with elided-posting auto-balance) + GL + cash-basis P&L | The core double-entry ledger and tenant isolation |
| **1** | Storage bucket + two-tab parser → canonical schema + validator battery + content-hash dedup + matching engine + Bank Rec tab + tie-out + period lock | Automated data entry + real reconciliation |
| **2** | Rules engine + categorization UI + suggestions + learning loop | The payoff across ~100 clients |
| **3** | Payroll summary → JE generation (per-provider parsers) | The Converse pattern, generalized |
| **4** | Review dashboard (prior-period compare, suspense queue, anomaly flags) + comparative reports + client package + exports | Reviewer throughput |
| **5** *(optional)* | PDF → filled-template extraction (Claude-powered) replacing manual keying; Plaid for big-bank clients | Eliminates the last manual step |

Note on Phase 5: decoupling extraction (PDF → template) from the app is what lets you automate keying later **without touching the app** — the app keeps accepting the same canonical schema. That clean seam is the reason the Excel-as-contract design is worth it even while you key by hand at first.

-----

## 9. Deliberately skipped

- **Plain-text format / DSL parser** — Postgres + RLS is the right multi-tenant store; emulate beancount's *model*, not its file format.
- **A query language (BQL)** — Postgres SQL covers reporting.
- **Commodity / lot / cost-basis / booking-method / inventory engine** — that's investment lot tracking; cash-basis service and municipal clients don't need it (~half of beancount's code).
- **A/R & A/P subledgers, accruals** — out of scope for cash basis by definition.
- **Plaid / live bank feeds in v1** — weak coverage for small banks and the weight of holding live credentials aren't worth it when one upload per client per month gets you ~95% there. Revisit in Phase 5 for big-bank clients only.
