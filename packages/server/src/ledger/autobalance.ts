import { isZero, round2, sumAmounts } from "../money.js";
import type { Posting, PostingInput } from "../types.js";

export interface AutobalanceResult {
  postings: Posting[];
  residual: number;
}

/**
 * Resolve a set of postings into a balanced transaction.
 *
 * - Exactly one posting may omit its amount; it is inferred as −(sum of the rest)
 *   so the transaction nets to zero (used by manual JEs and split deposits).
 * - If no amount is omitted, the postings must already net to zero within tolerance.
 * - More than one omitted amount, or an unbalanced explicit set, is rejected.
 */
export function autobalance(postings: PostingInput[]): AutobalanceResult {
  if (postings.length < 2) {
    throw new Error("A transaction needs at least two postings");
  }

  const missing = postings.flatMap((p, i) => (p.amount == null ? [i] : []));

  if (missing.length > 1) {
    throw new Error("More than one posting amount was omitted; cannot autobalance");
  }

  if (missing.length === 1) {
    const idx = missing[0];
    const rest = postings.filter((_, i) => i !== idx).map((p) => p.amount as number);
    const inferred = round2(-sumAmounts(rest));
    const resolved = postings.map((p, i) =>
      i === idx ? { ...p, amount: inferred } : { ...p, amount: p.amount as number }
    );
    return { postings: resolved, residual: 0 };
  }

  const amounts = postings.map((p) => p.amount as number);
  const residual = round2(sumAmounts(amounts));
  if (!isZero(residual)) {
    throw new Error(`Postings do not balance: residual ${residual}`);
  }
  const resolved = postings.map((p) => ({ ...p, amount: p.amount as number }));
  return { postings: resolved, residual };
}
