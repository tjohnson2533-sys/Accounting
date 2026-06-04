import { describe, expect, it } from "vitest";
import { autobalance } from "./autobalance.js";

describe("autobalance", () => {
  it("infers a single elided posting amount", () => {
    const { postings, residual } = autobalance([
      { account_id: "expense", amount: 100 },
      { account_id: "cash" }, // elided
    ]);
    expect(residual).toBe(0);
    expect(postings[1].amount).toBe(-100);
  });

  it("infers across a split deposit", () => {
    const { postings } = autobalance([
      { account_id: "cash", amount: 500 },
      { account_id: "sales", amount: -300 },
      { account_id: "service" }, // elided → -200
    ]);
    expect(postings[2].amount).toBe(-200);
  });

  it("accepts an already-balanced explicit set", () => {
    const { residual } = autobalance([
      { account_id: "cash", amount: 250 },
      { account_id: "income", amount: -250 },
    ]);
    expect(residual).toBe(0);
  });

  it("rejects an unbalanced explicit set", () => {
    expect(() =>
      autobalance([
        { account_id: "cash", amount: 250 },
        { account_id: "income", amount: -240 },
      ])
    ).toThrow(/do not balance/);
  });

  it("rejects more than one elided amount", () => {
    expect(() =>
      autobalance([{ account_id: "a" }, { account_id: "b" }])
    ).toThrow(/More than one/);
  });
});
