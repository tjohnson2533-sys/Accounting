import { Router } from "express";
import { db } from "../db.js";
import { commitImport } from "../import/commitImport.js";
import { loadWorkbookFile, parseWorkbook, type RawWorkbook } from "../import/parseWorkbook.js";
import { validateWorkbook } from "../import/validate.js";
import { commitTransaction } from "../ledger/post.js";
import { computeReconciliation, finalizeReconciliation } from "../recon/reconcile.js";
import type { ParsedWorkbook } from "../types.js";

export const router = Router();

// NOTE: every handler must resolve and pass entity_id explicitly (service role bypasses RLS).
// Auth: the caller's Supabase JWT should be verified and mapped to a membership before these
// run — wired in index.ts middleware (left as a TODO marker here).

/** Manual journal entry → balanced, posted transaction. */
router.post("/journal-entries", async (req, res) => {
  try {
    const { entityId, date, payee, description, postings, userId } = req.body;
    const result = await commitTransaction({
      entityId,
      date,
      payee,
      description,
      source: "manual_je",
      status: "posted",
      createdBy: userId,
      postings,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Validate a workbook (already parsed or raw rows) without committing. */
router.post("/imports/validate", async (req, res) => {
  try {
    const wb: ParsedWorkbook = req.body.raw
      ? parseWorkbook(req.body.raw as RawWorkbook)
      : (req.body.parsed as ParsedWorkbook);
    res.json(validateWorkbook(wb));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * Commit an import batch: re-validate, then parse → commit → match. The batch row
 * (with bank account + period + balances) must already exist from the upload step.
 */
router.post("/imports/:batchId/commit", async (req, res) => {
  try {
    const { entityId, userId, rawWorkbook, fileBase64 } = req.body;
    const batchId = req.params.batchId;

    const wb: ParsedWorkbook = fileBase64
      ? await loadWorkbookFile(Buffer.from(fileBase64, "base64"))
      : parseWorkbook(rawWorkbook as RawWorkbook);

    const validation = validateWorkbook(wb);
    if (validation.errors.length > 0) {
      return res.status(422).json({ stage: "validation", ...validation });
    }

    const { data: batch, error } = await db()
      .from("import_batches")
      .select("bank_account_id, statement_period_end, statement_ending_balance, bank_accounts!inner(account_id)")
      .eq("id", batchId)
      .eq("entity_id", entityId)
      .single();
    if (error) throw error;

    const suspense = await resolveSuspense(entityId);

    const result = await commitImport(wb, {
      entityId,
      bankAccountId: batch.bank_account_id,
      glAccountId: (batch as any).bank_accounts.account_id,
      suspenseAccountId: suspense,
      importBatchId: batchId,
      userId,
      periodEnd: batch.statement_period_end,
      statementEndingBalance: Number(batch.statement_ending_balance),
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * Upload & process a workbook in one shot: parse → validate → create the import_batch
 * (from the Setup tab) → commit + match. One workbook = one bank account = one batch.
 */
router.post("/imports", async (req, res) => {
  try {
    const { entityId, bankAccountId, userId, fileBase64 } = req.body;
    const wb = await loadWorkbookFile(Buffer.from(fileBase64, "base64"));

    const validation = validateWorkbook(wb);
    if (validation.errors.length > 0) {
      return res.status(422).json({ stage: "validation", ...validation });
    }

    // Resolve the bank account's GL account.
    const { data: bank, error: bankErr } = await db()
      .from("bank_accounts")
      .select("account_id")
      .eq("id", bankAccountId)
      .eq("entity_id", entityId)
      .single();
    if (bankErr) throw bankErr;

    // Create the batch from the Setup tab.
    const { data: batch, error: batchErr } = await db()
      .from("import_batches")
      .insert({
        entity_id: entityId,
        bank_account_id: bankAccountId,
        uploaded_by: userId,
        template_version: wb.setup.templateVersion,
        statement_period_start: wb.setup.periodStart,
        statement_period_end: wb.setup.periodEnd,
        statement_beginning_balance: wb.setup.beginningBalance,
        statement_ending_balance: wb.setup.endingBalance,
        status: "validated",
      })
      .select("id")
      .single();
    if (batchErr) throw batchErr;

    const suspense = await resolveSuspense(entityId);
    const result = await commitImport(wb, {
      entityId,
      bankAccountId,
      glAccountId: (bank as any).account_id,
      suspenseAccountId: suspense,
      importBatchId: batch.id,
      userId,
      periodEnd: wb.setup.periodEnd,
      statementEndingBalance: wb.setup.endingBalance,
    });
    res.json({ batchId: batch.id, glAccountId: (bank as any).account_id, result });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Compute / refresh the tie-out for a batch. */
router.post("/reconciliations/compute", async (req, res) => {
  try {
    const { entityId, bankAccountId, glAccountId, importBatchId } = req.body;
    res.json(await computeReconciliation({ entityId, bankAccountId, glAccountId, importBatchId }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Finalize a reconciliation (locks the period when difference is zero). */
router.post("/reconciliations/:id/finalize", async (req, res) => {
  try {
    const { entityId, userId } = req.body;
    await finalizeReconciliation({ entityId, reconciliationId: req.params.id, userId });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

async function resolveSuspense(entityId: string): Promise<string> {
  const { data, error } = await db()
    .from("accounts")
    .select("id")
    .eq("entity_id", entityId)
    .eq("code", "9999")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No Suspense account (code 9999) found for this entity");
  return data.id;
}
