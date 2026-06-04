import { db, requireEntity, writeAudit } from "../db.js";
import { sumAmounts } from "../money.js";
import { computeTieOut, type TieOut } from "./tieout.js";

/**
 * Compute (and persist) the bank-rec tie-out for an import batch, deriving everything
 * from the per-posting cleared flag and the statement balance assertion (Build Doc §5).
 */
export async function computeReconciliation(args: {
  entityId: string;
  bankAccountId: string;
  glAccountId: string;
  importBatchId: string;
}): Promise<{ reconciliationId: string; tieOut: TieOut }> {
  const entityId = requireEntity(args.entityId);

  const { data: batch, error: batchErr } = await db()
    .from("import_batches")
    .select("statement_ending_balance, statement_period_end")
    .eq("id", args.importBatchId)
    .eq("entity_id", entityId)
    .single();
  if (batchErr) throw batchErr;

  const periodEnd: string = batch.statement_period_end;
  const statementEndingBalance = Number(batch.statement_ending_balance);

  // Uncleared cash-leg postings as of period_end (outstanding checks + deposits in transit).
  const { data: uncleared, error: unErr } = await db()
    .from("postings")
    .select("amount, transactions!inner(txn_date)")
    .eq("entity_id", entityId)
    .eq("account_id", args.glAccountId)
    .eq("cleared", false)
    .lte("transactions.txn_date", periodEnd);
  if (unErr) throw unErr;
  const unclearedAsOf = (uncleared ?? []).map((p: any) => ({
    amount: Number(p.amount),
    date: p.transactions.txn_date,
  }));

  // Book cash balance = Σ posted cash-account postings.
  const { data: posted, error: pErr } = await db()
    .from("postings")
    .select("amount, transactions!inner(status)")
    .eq("entity_id", entityId)
    .eq("account_id", args.glAccountId)
    .eq("transactions.status", "posted");
  if (pErr) throw pErr;
  const bookBalance = sumAmounts((posted ?? []).map((p: any) => Number(p.amount)));

  const tieOut = computeTieOut({ statementEndingBalance, unclearedAsOfPeriodEnd: unclearedAsOf, bookBalance });

  // Upsert the reconciliation record for this batch.
  const row = {
    entity_id: entityId,
    bank_account_id: args.bankAccountId,
    import_batch_id: args.importBatchId,
    statement_ending_balance: tieOut.statementEndingBalance,
    computed_cleared_balance: tieOut.computedClearedBalance,
    outstanding_total: tieOut.outstandingChecks,
    in_transit_total: tieOut.depositsInTransit,
    book_balance: tieOut.bookBalance,
    difference: tieOut.difference,
    status: "in_progress" as const,
  };
  const { data: existing } = await db()
    .from("reconciliations")
    .select("id")
    .eq("entity_id", entityId)
    .eq("import_batch_id", args.importBatchId)
    .maybeSingle();

  let reconciliationId: string;
  if (existing) {
    const { error } = await db().from("reconciliations").update(row).eq("id", existing.id);
    if (error) throw error;
    reconciliationId = existing.id;
  } else {
    const { data, error } = await db().from("reconciliations").insert(row).select("id").single();
    if (error) throw error;
    reconciliationId = data.id;
  }

  return { reconciliationId, tieOut };
}

/**
 * Finalize a reconciliation: only allowed when the tie-out difference is within tolerance.
 * Sets status='reconciled' and advances the entity's period lock to the statement period_end.
 */
export async function finalizeReconciliation(args: {
  entityId: string;
  reconciliationId: string;
  userId: string;
}): Promise<void> {
  const entityId = requireEntity(args.entityId);

  const { data: recon, error } = await db()
    .from("reconciliations")
    .select("difference, import_batch_id, import_batches!inner(statement_period_end)")
    .eq("id", args.reconciliationId)
    .eq("entity_id", entityId)
    .single();
  if (error) throw error;

  if (Math.abs(Number(recon.difference)) > 0.005) {
    throw new Error(`Cannot reconcile: difference ${recon.difference} exceeds tolerance`);
  }
  const periodEnd = (recon as any).import_batches.statement_period_end as string;

  const { error: rErr } = await db()
    .from("reconciliations")
    .update({ status: "reconciled", reconciled_by: args.userId, reconciled_at: new Date().toISOString() })
    .eq("id", args.reconciliationId)
    .eq("entity_id", entityId);
  if (rErr) throw rErr;

  // Advance the period lock (upsert on the entity-keyed table).
  const { error: lErr } = await db()
    .from("period_locks")
    .upsert(
      { entity_id: entityId, locked_through: periodEnd, locked_by: args.userId, locked_at: new Date().toISOString() },
      { onConflict: "entity_id" }
    );
  if (lErr) throw lErr;

  await writeAudit({
    entityId,
    actor: args.userId,
    action: "reconcile",
    tableName: "reconciliations",
    rowId: args.reconciliationId,
    after: { locked_through: periodEnd },
  });
}
