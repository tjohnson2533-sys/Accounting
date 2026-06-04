import { describe, expect, it } from "vitest";
import type { StatementRow } from "../types.js";
import { matchStatement, type UnclearedPosting } from "./match.js";

function stmt(rowIndex: number, date: string, amount: number, checkNumber: string | null = null): StatementRow {
  return {
    rowIndex,
    date,
    description: checkNumber ? `CHECK ${checkNumber}` : "LINE",
    checkNumber,
    payment: amount < 0 ? -amount : 0,
    deposit: amount > 0 ? amount : 0,
    memo: "",
    amount,
  };
}

describe("matchStatement", () => {
  it("matches a check by check number (clears, never duplicates)", () => {
    const standing: UnclearedPosting[] = [
      { postingId: "p1", transactionId: "t1", date: "2025-12-05", amount: -100, checkNumber: "1001" },
    ];
    const { results, cleared, bankOnly } = matchStatement([stmt(1, "2025-12-06", -100, "1001")], standing);
    expect(results[0].outcome).toBe("matched");
    expect(cleared).toEqual([{ postingId: "p1", clearedDate: "2025-12-06", lineRowIndex: 1 }]);
    expect(bankOnly).toHaveLength(0);
  });

  it("clears a December-outstanding check on the January statement (no duplicate)", () => {
    // Check written & booked in December, still uncleared at year end.
    const standing: UnclearedPosting[] = [
      { postingId: "dec-chk", transactionId: "t1", date: "2025-12-28", amount: -250, checkNumber: "1042" },
    ];
    // It appears on the January statement.
    const { results, cleared } = matchStatement([stmt(1, "2026-01-03", -250, "1042")], standing);
    expect(results[0].outcome).toBe("matched");
    expect(cleared[0].postingId).toBe("dec-chk");
  });

  it("matches a no-check line by amount within the date window", () => {
    const standing: UnclearedPosting[] = [
      { postingId: "dep", transactionId: "t2", date: "2025-12-10", amount: 500, checkNumber: null },
    ];
    const { results } = matchStatement([stmt(1, "2025-12-12", 500)], standing);
    expect(results[0].outcome).toBe("matched");
  });

  it("leaves a line unmatched when multiple candidates tie on amount+date", () => {
    const standing: UnclearedPosting[] = [
      { postingId: "a", transactionId: "ta", date: "2025-12-10", amount: -75, checkNumber: null },
      { postingId: "b", transactionId: "tb", date: "2025-12-11", amount: -75, checkNumber: null },
    ];
    const { results, cleared } = matchStatement([stmt(1, "2025-12-12", -75)], standing);
    expect(results[0].outcome).toBe("unmatched");
    expect(cleared).toHaveLength(0);
  });

  it("treats a statement-only fee as a bank-only item", () => {
    const { results, bankOnly } = matchStatement([stmt(1, "2025-12-31", -15)], []);
    expect(results[0].outcome).toBe("bank_only");
    expect(bankOnly).toHaveLength(1);
  });

  it("consumes the pool so one posting clears at most one line", () => {
    const standing: UnclearedPosting[] = [
      { postingId: "p1", transactionId: "t1", date: "2025-12-05", amount: -100, checkNumber: "1001" },
    ];
    const lines = [stmt(1, "2025-12-06", -100, "1001"), stmt(2, "2025-12-07", -100, "1001")];
    const { results, cleared } = matchStatement(lines, standing);
    expect(cleared).toHaveLength(1);
    expect(results[0].outcome).toBe("matched");
    expect(results[1].outcome).toBe("bank_only"); // pool exhausted
  });
});
