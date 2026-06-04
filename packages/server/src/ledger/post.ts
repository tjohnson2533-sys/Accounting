import { db, isPeriodLocked, requireEntity } from "../db.js";
import { contentHash } from "../import/dedup.js";
import type { PostingInput, TxnSource } from "../types.js";
import { autobalance } from "./autobalance.js";

export interface CommitTransactionInput {
  entityId: string;
  date: string; // ISO yyyy-mm-dd
  payee?: string | null;
  description?: string | null;
  source: TxnSource;
  status?: "imported" | "categorized" | "reviewed" | "posted";
  importBatchId?: string | null;
  createdBy?: string | null;
  postings: PostingInput[];
  /** Override the dedup key inputs (the matcher supplies the bank-leg check number). */
  hashCheckNumber?: string | null;
}

export interface CommitResult {
  transactionId: string | null; // null = deduped (idempotent skip)
  deduped: boolean;
}

/**
 * Commit one balanced transaction atomically (Build Doc §3/§4):
 *  - reject if the date falls in a locked period,
 *  - autobalance the postings (infer a single elided amount),
 *  - dedup on content_hash,
 *  - insert transaction + postings + audit in a single DB transaction (RPC), with the
 *    deferred trigger enforcing debits = credits at commit.
 */
export async function commitTransaction(input: CommitTransactionInput): Promise<CommitResult> {
  const entityId = requireEntity(input.entityId);

  if (await isPeriodLocked(entityId, input.date)) {
    throw new Error(`Period is locked; cannot post on ${input.date}`);
  }

  const { postings } = autobalance(input.postings);

  const signedAmount = postings.reduce((acc, p) => acc + p.amount, 0);
  const hash = contentHash({
    entityId,
    txnDate: input.date,
    signedAmount,
    payee: input.payee,
    checkNumber: input.hashCheckNumber ?? postings.find((p) => p.check_number)?.check_number ?? null,
  });

  const { data, error } = await db().rpc("commit_transaction", {
    p_entity_id: entityId,
    p_txn_date: input.date,
    p_payee: input.payee ?? null,
    p_description: input.description ?? null,
    p_source: input.source,
    p_status: input.status ?? "imported",
    p_content_hash: hash,
    p_import_batch_id: input.importBatchId ?? null,
    p_created_by: input.createdBy ?? null,
    p_postings: postings.map((p) => ({
      account_id: p.account_id,
      class_id: p.class_id ?? null,
      amount: p.amount,
      check_number: p.check_number ?? null,
      meta: p.meta ?? {},
    })),
  });

  if (error) throw error;
  const transactionId = (data as string | null) ?? null;
  return { transactionId, deduped: transactionId === null };
}
