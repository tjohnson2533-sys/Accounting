import { isZero, round2, sumAmounts } from "../money.js";

/** An uncleared book cash-leg posting as of period_end. */
export interface UnclearedAsOf {
  amount: number; // signed: + deposit-to-cash / − check-to-cash
  date: string; // ISO yyyy-mm-dd (<= period_end)
}

export interface TieOut {
  statementEndingBalance: number;
  depositsInTransit: number; // uncleared debit-to-cash (amount > 0)
  outstandingChecks: number; // uncleared credit-to-cash (amount < 0), negative
  adjustedBank: number; // statementEnding + depositsInTransit + outstandingChecks
  bookBalance: number; // Σ cash-account postings, status='posted'
  computedClearedBalance: number; // bookBalance minus not-yet-cleared items
  difference: number; // adjustedBank − bookBalance
  isReconciled: boolean; // |difference| ≤ tolerance
}

/**
 * Classic bank-rec tie-out (Build Doc §5):
 *   statement ending + deposits in transit − outstanding checks = adjusted bank
 *   adjusted bank must equal book cash balance; difference → 0 lets the period lock.
 */
export function computeTieOut(args: {
  statementEndingBalance: number;
  unclearedAsOfPeriodEnd: UnclearedAsOf[];
  bookBalance: number;
}): TieOut {
  const { statementEndingBalance, unclearedAsOfPeriodEnd, bookBalance } = args;

  const depositsInTransit = sumAmounts(
    unclearedAsOfPeriodEnd.filter((p) => p.amount > 0).map((p) => p.amount)
  );
  const outstandingChecks = sumAmounts(
    unclearedAsOfPeriodEnd.filter((p) => p.amount < 0).map((p) => p.amount)
  );

  const adjustedBank = round2(statementEndingBalance + depositsInTransit + outstandingChecks);
  const difference = round2(adjustedBank - bookBalance);
  const computedClearedBalance = round2(bookBalance - depositsInTransit - outstandingChecks);

  return {
    statementEndingBalance: round2(statementEndingBalance),
    depositsInTransit,
    outstandingChecks,
    adjustedBank,
    bookBalance: round2(bookBalance),
    computedClearedBalance,
    difference,
    isReconciled: isZero(difference),
  };
}
