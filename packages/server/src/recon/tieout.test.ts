import { describe, expect, it } from "vitest";
import { computeTieOut } from "./tieout.js";

describe("computeTieOut", () => {
  it("ties out to zero with outstanding checks and deposits in transit", () => {
    // Book balance 1000. One $250 check (uncleared) and one $400 deposit (uncleared).
    // Statement ending = 1000 + 250 (check not yet cleared) − 400 (deposit not yet credited)
    //                  = 850.
    const t = computeTieOut({
      statementEndingBalance: 850,
      unclearedAsOfPeriodEnd: [
        { amount: -250, date: "2025-12-28" }, // outstanding check
        { amount: 400, date: "2025-12-31" }, // deposit in transit
      ],
      bookBalance: 1000,
    });
    expect(t.outstandingChecks).toBe(-250);
    expect(t.depositsInTransit).toBe(400);
    expect(t.adjustedBank).toBe(1000); // 850 + 400 − 250
    expect(t.difference).toBe(0);
    expect(t.isReconciled).toBe(true);
  });

  it("reports a non-zero difference and blocks reconciliation", () => {
    const t = computeTieOut({
      statementEndingBalance: 800,
      unclearedAsOfPeriodEnd: [{ amount: -250, date: "2025-12-28" }],
      bookBalance: 1000,
    });
    expect(t.adjustedBank).toBe(550); // 800 − 250
    expect(t.difference).toBe(-450);
    expect(t.isReconciled).toBe(false);
  });

  it("reconciles cleanly when nothing is outstanding", () => {
    const t = computeTieOut({ statementEndingBalance: 1000, unclearedAsOfPeriodEnd: [], bookBalance: 1000 });
    expect(t.difference).toBe(0);
    expect(t.isReconciled).toBe(true);
  });
});
