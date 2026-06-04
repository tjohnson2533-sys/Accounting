import { approxEqual } from "../money.js";
import type { StatementRow } from "../types.js";

/** A standing uncleared book cash-leg posting (loaded across ALL periods). */
export interface UnclearedPosting {
  postingId: string;
  transactionId: string;
  date: string; // ISO yyyy-mm-dd of the book entry
  amount: number; // signed cash-leg amount: + deposit / − check
  checkNumber: string | null;
}

export type MatchOutcome = "matched" | "unmatched" | "bank_only";

export interface LineMatchResult {
  lineRowIndex: number;
  outcome: MatchOutcome;
  /** The posting cleared by this line (matched only). */
  matchedPostingId?: string;
  matchedTransactionId?: string;
}

export interface MatchSummary {
  results: LineMatchResult[];
  /** Postings that got cleared, paired with the clearing line's row index/date. */
  cleared: { postingId: string; clearedDate: string; lineRowIndex: number }[];
  /** Statement rows that matched nothing and become bank-only transactions. */
  bankOnly: StatementRow[];
}

const DATE_WINDOW_DAYS = 5;

function dayDiff(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(da - db) / 86_400_000;
}

/**
 * Two-list matcher (Build Doc §4). For each statement line:
 *  1. check# present → exact match on check# + amount → clear the book posting;
 *  2. otherwise → uncleared postings with equal signed amount within ±5 days:
 *     exactly one → clear; multiple → leave unmatched for manual pick;
 *  3. no candidate → bank-only item (a transaction is generated downstream).
 *
 * A statement line NEVER spawns a duplicate of a matched book entry — it clears it.
 * The uncleared pool is consumed as matches are made so one posting clears one line.
 */
export function matchStatement(
  statementRows: StatementRow[],
  standingSet: UnclearedPosting[]
): MatchSummary {
  const pool = [...standingSet];
  const results: LineMatchResult[] = [];
  const cleared: MatchSummary["cleared"] = [];
  const bankOnly: StatementRow[] = [];

  const take = (idx: number, line: StatementRow): LineMatchResult => {
    const [p] = pool.splice(idx, 1);
    cleared.push({ postingId: p.postingId, clearedDate: line.date, lineRowIndex: line.rowIndex });
    return {
      lineRowIndex: line.rowIndex,
      outcome: "matched",
      matchedPostingId: p.postingId,
      matchedTransactionId: p.transactionId,
    };
  };

  for (const line of statementRows) {
    // 1. check-number match
    if (line.checkNumber) {
      const idx = pool.findIndex(
        (p) => p.checkNumber && p.checkNumber === line.checkNumber && approxEqual(p.amount, line.amount)
      );
      if (idx >= 0) {
        results.push(take(idx, line));
        continue;
      }
    }

    // 2. amount + date-window candidates
    const candidates = pool.filter(
      (p) => approxEqual(p.amount, line.amount) && dayDiff(p.date, line.date) <= DATE_WINDOW_DAYS
    );
    if (candidates.length === 1) {
      const idx = pool.indexOf(candidates[0]);
      results.push(take(idx, line));
      continue;
    }
    if (candidates.length > 1) {
      results.push({ lineRowIndex: line.rowIndex, outcome: "unmatched" });
      continue;
    }

    // 3. no match → bank-only
    results.push({ lineRowIndex: line.rowIndex, outcome: "bank_only" });
    bankOnly.push(line);
  }

  return { results, cleared, bankOnly };
}
