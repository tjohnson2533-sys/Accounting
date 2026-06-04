import { describe, expect, it } from "vitest";
import { balanceSheet, generalLedger, profitAndLoss, trialBalance, type ReportPosting } from "./cashbasis.js";

// A tiny posted set: $500 deposit (Dr cash / Cr sales) and a $100 rent check (Dr rent / Cr cash).
const rows: ReportPosting[] = [
  { accountId: "cash", accountCode: "1000", accountName: "Checking", accountType: "asset", amount: 500, date: "2025-12-10", transactionId: "t1" },
  { accountId: "sales", accountCode: "4000", accountName: "Sales", accountType: "income", amount: -500, date: "2025-12-10", transactionId: "t1" },
  { accountId: "cash", accountCode: "1000", accountName: "Checking", accountType: "asset", amount: -100, date: "2025-12-12", transactionId: "t2" },
  { accountId: "rent", accountCode: "6000", accountName: "Rent", accountType: "expense", amount: 100, date: "2025-12-12", transactionId: "t2" },
];

describe("cash-basis reports", () => {
  it("trial balance: total debits equal total credits", () => {
    const tb = trialBalance(rows);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.inBalance).toBe(true);
  });

  it("P&L: income − expense = net income", () => {
    const pl = profitAndLoss(rows);
    expect(pl.totalIncome).toBe(500);
    expect(pl.totalExpense).toBe(100);
    expect(pl.netIncome).toBe(400);
  });

  it("balance sheet: assets = liabilities + equity (equity includes net income)", () => {
    const bs = balanceSheet(rows);
    expect(bs.totalAssets).toBe(400); // 500 − 100 cash
    expect(bs.netIncome).toBe(400);
    expect(bs.totalEquity).toBe(400);
    expect(bs.inBalance).toBe(true);
  });

  it("general ledger: running balance per account", () => {
    const gl = generalLedger(rows);
    const cash = gl.get("cash")!;
    expect(cash.map((l) => l.runningBalance)).toEqual([500, 400]);
  });
});
