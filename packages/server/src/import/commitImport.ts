import { db, requireEntity } from "../db.js";
import { commitTransaction } from "../ledger/post.js";
import type { ParsedWorkbook, StatementRow } from "../types.js";
import { matchStatement, type UnclearedPosting } from "./match.js";

export interface CommitImportContext {
  entityId: string;
  bankAccountId: string;
  glAccountId: string; // the bank's GL cash account
  suspenseAccountId: string; // offset until the Phase 2 rules engine categorizes
  importBatchId: string;
  userId?: string | null;
  periodEnd: string; // ISO yyyy-mm-dd
  statementEndingBalance: number;
}

export interface CommitImportResult {
  bookCommitted: number;
  bookDeduped: number;
  matched: number;
  unmatched: number;
  bankOnlyBooked: number;
}

/**
 * Phase-1 import: commit Book rows, match Statement lines against the standing uncleared
 * set, clear matches, book bank-only items, and write the statement balance assertion.
 * Categorization is deferred to Phase 2, so every offset posts to Suspense for now.
 */
export async function commitImport(
  wb: ParsedWorkbook,
  ctx: CommitImportContext
): Promise<CommitImportResult> {
  const entityId = requireEntity(ctx.entityId);
  const result: CommitImportResult = {
    bookCommitted: 0,
    bookDeduped: 0,
    matched: 0,
    unmatched: 0,
    bankOnlyBooked: 0,
  };

  // 1. Commit Book rows (cash leg on the bank account, offset to Suspense).
  for (const r of wb.bookRows) {
    const res = await commitTransaction({
      entityId,
      date: r.date,
      payee: r.payee,
      description: r.memo || r.payee,
      source: "book_import",
      status: "imported",
      importBatchId: ctx.importBatchId,
      createdBy: ctx.userId,
      hashCheckNumber: r.checkNumber,
      postings: [
        { account_id: ctx.glAccountId, amount: r.amount, check_number: r.checkNumber },
        { account_id: ctx.suspenseAccountId, amount: -r.amount },
      ],
    });
    if (res.deduped) result.bookDeduped += 1;
    else result.bookCommitted += 1;
  }

  // 2. Persist statement lines for provenance + UI, keep rowIndex → id map.
  const lineRows = wb.statementRows.map((r) => ({
    entity_id: entityId,
    import_batch_id: ctx.importBatchId,
    bank_account_id: ctx.bankAccountId,
    line_date: r.date,
    description: r.description,
    check_number: r.checkNumber,
    amount: r.amount,
    match_status: "unmatched" as const,
  }));
  const { data: insertedLines, error: lineErr } = await db()
    .from("statement_lines")
    .insert(lineRows)
    .select("id, line_date, amount, check_number");
  if (lineErr) throw lineErr;
  // Inserted rows come back in insert order; pair them with the source rows by index.
  const lineIdByRowIndex = new Map<number, string>();
  wb.statementRows.forEach((r, i) => lineIdByRowIndex.set(r.rowIndex, insertedLines![i].id));

  // 3. Load the standing uncleared set for this bank account (ALL periods).
  const standingSet = await loadStandingSet(entityId, ctx.glAccountId);

  // 4. Match.
  const summary = matchStatement(wb.statementRows, standingSet);

  // 5. Clear matched postings.
  for (const c of summary.cleared) {
    const lineId = lineIdByRowIndex.get(c.lineRowIndex)!;
    const { error } = await db().rpc("clear_posting", {
      p_entity_id: entityId,
      p_posting_id: c.postingId,
      p_line_id: lineId,
      p_cleared_date: c.clearedDate,
      p_cleared_by: ctx.userId ?? null,
    });
    if (error) throw error;
    result.matched += 1;
  }
  result.unmatched = summary.results.filter((r) => r.outcome === "unmatched").length;

  // 6. Book bank-only items (fees/interest/ACH) → Suspense, flag the line.
  for (const line of summary.bankOnly) {
    await bookBankOnly(line, ctx, entityId, lineIdByRowIndex.get(line.rowIndex)!);
    result.bankOnlyBooked += 1;
  }

  // 7. Statement balance assertion.
  const { error: baErr } = await db().from("balance_assertions").insert({
    entity_id: entityId,
    account_id: ctx.glAccountId,
    assert_date: addDays(ctx.periodEnd, 1),
    amount: ctx.statementEndingBalance,
    source: "statement",
    import_batch_id: ctx.importBatchId,
  });
  if (baErr) throw baErr;

  // 8. Mark batch matched.
  const { error: batchErr } = await db()
    .from("import_batches")
    .update({ status: "matched" })
    .eq("id", ctx.importBatchId)
    .eq("entity_id", entityId);
  if (batchErr) throw batchErr;

  return result;
}

async function loadStandingSet(entityId: string, glAccountId: string): Promise<UnclearedPosting[]> {
  const { data, error } = await db()
    .from("postings")
    .select("id, transaction_id, amount, check_number, transactions!inner(txn_date)")
    .eq("entity_id", entityId)
    .eq("account_id", glAccountId)
    .eq("cleared", false);
  if (error) throw error;
  return (data ?? []).map((p: any) => ({
    postingId: p.id,
    transactionId: p.transaction_id,
    date: p.transactions.txn_date,
    amount: Number(p.amount),
    checkNumber: p.check_number,
  }));
}

async function bookBankOnly(
  line: StatementRow,
  ctx: CommitImportContext,
  entityId: string,
  lineId: string
): Promise<void> {
  const res = await commitTransaction({
    entityId,
    date: line.date,
    payee: line.description,
    description: line.memo || line.description,
    source: "bank_only",
    status: "imported",
    importBatchId: ctx.importBatchId,
    createdBy: ctx.userId,
    hashCheckNumber: line.checkNumber,
    postings: [
      { account_id: ctx.glAccountId, amount: line.amount, check_number: line.checkNumber },
      { account_id: ctx.suspenseAccountId, amount: -line.amount },
    ],
  });

  // The bank-only cash leg is, by definition, already on the statement → mark cleared
  // and link the line. Skip if the row deduped against an earlier import.
  if (!res.deduped && res.transactionId) {
    const { data: posting } = await db()
      .from("postings")
      .select("id")
      .eq("transaction_id", res.transactionId)
      .eq("account_id", ctx.glAccountId)
      .maybeSingle();
    if (posting) {
      await db().rpc("clear_posting", {
        p_entity_id: entityId,
        p_posting_id: posting.id,
        p_line_id: lineId,
        p_cleared_date: line.date,
        p_cleared_by: ctx.userId ?? null,
      });
    }
  }
  await db()
    .from("statement_lines")
    .update({ match_status: "bank_only_booked" })
    .eq("id", lineId)
    .eq("entity_id", entityId);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
