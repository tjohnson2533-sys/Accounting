import { describe, expect, it } from "vitest";
import { parseWorkbook, type RawWorkbook } from "./parseWorkbook.js";

const raw: RawWorkbook = {
  setup: [
    ["template_version", "v1"],
    ["client", "Acme LLC"],
    ["bank_account", "Operating Checking"],
    ["period_start", "2025-12-01"],
    ["period_end", "2025-12-31"],
    ["beginning_balance", 1000],
    ["ending_balance", 900],
  ],
  book: [
    ["Date", "Type", "Check #", "Payee/Description", "Payment", "Deposit", "Memo"],
    ["2025-12-05", "Check", "1001", "Rent", 100, 0, "office"],
    ["2025-12-10", "Deposit", "", "Customer", 0, 250, "invoice 5"],
  ],
  statement: [
    ["Date", "Description", "Check #", "Payment", "Deposit", "Memo"],
    ["2025-12-06", "CHECK 1001", "1001", 100, 0, ""],
    ["2025-12-31", "SERVICE FEE", "", 15, 0, ""],
  ],
};

// The real shipped template's verbose Setup labels (Build Doc §4 / v1 xlsx).
const realSetupRows = [
  ["LedgerPro — Monthly Import Template"],
  ["One workbook = one bank account = one statement period."],
  [],
  ["Template Version", "1.0", "← do not edit (the importer reads this)"],
  [],
  ["Client / Entity", "Acme LLC"],
  ["Bank Account (name or last 4)", "Operating Checking"],
  ["Statement Period Start", "2025-12-01"],
  ["Statement Period End", "2025-12-31"],
  ["Statement Beginning Balance", 1000],
  ["Statement Ending Balance", 900],
  [],
  [],
  ["STATEMENT SELF-CHECK"],
  ["Statement deposits/credits entered", 0],
  ["Expected ending (Begin + Credits − Debits)", 900],
];

describe("parseWorkbook", () => {
  it("parses the real template's verbose Setup labels and version 1.0", () => {
    const { setup } = parseWorkbook({ setup: realSetupRows, book: [], statement: [] });
    expect(setup).toMatchObject({
      templateVersion: "1.0",
      clientName: "Acme LLC",
      bankAccount: "Operating Checking",
      periodStart: "2025-12-01",
      periodEnd: "2025-12-31",
      beginningBalance: 1000,
      endingBalance: 900,
    });
  });

  it("parses setup key/value rows", () => {
    const { setup } = parseWorkbook(raw);
    expect(setup).toMatchObject({
      templateVersion: "v1",
      clientName: "Acme LLC",
      bankAccount: "Operating Checking",
      periodStart: "2025-12-01",
      periodEnd: "2025-12-31",
      beginningBalance: 1000,
      endingBalance: 900,
    });
  });

  it("skips the header row and signs amounts (deposit − payment)", () => {
    const { bookRows, statementRows } = parseWorkbook(raw);
    expect(bookRows).toHaveLength(2);
    expect(bookRows[0]).toMatchObject({ rowIndex: 1, checkNumber: "1001", amount: -100 });
    expect(bookRows[1]).toMatchObject({ rowIndex: 2, checkNumber: null, amount: 250 });
    expect(statementRows[0]).toMatchObject({ amount: -100, checkNumber: "1001" });
    expect(statementRows[1]).toMatchObject({ amount: -15, description: "SERVICE FEE" });
  });
});
