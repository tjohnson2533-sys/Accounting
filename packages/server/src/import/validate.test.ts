import { describe, expect, it } from "vitest";
import type { ParsedWorkbook } from "../types.js";
import { validateWorkbook } from "./validate.js";

function wb(overrides: Partial<ParsedWorkbook> = {}): ParsedWorkbook {
  return {
    setup: {
      templateVersion: "v1",
      clientName: "Acme LLC",
      bankAccount: "Operating Checking",
      periodStart: "2025-12-01",
      periodEnd: "2025-12-31",
      beginningBalance: 1000,
      endingBalance: 900,
      ...overrides.setup,
    },
    bookRows: overrides.bookRows ?? [
      { rowIndex: 1, date: "2025-12-05", type: "Check", checkNumber: "1001", payee: "Rent", payment: 100, deposit: 0, memo: "", amount: -100 },
    ],
    statementRows: overrides.statementRows ?? [
      { rowIndex: 1, date: "2025-12-06", description: "CHECK 1001", checkNumber: "1001", payment: 100, deposit: 0, memo: "", amount: -100 },
    ],
  };
}

describe("validateWorkbook", () => {
  it("passes a clean, tying workbook", () => {
    const { errors } = validateWorkbook(wb());
    expect(errors).toHaveLength(0);
  });

  it("accumulates ALL errors rather than failing fast", () => {
    const { errors } = validateWorkbook(
      wb({
        setup: {
          templateVersion: "v9", // unsupported
          clientName: "",
          bankAccount: "X",
          periodStart: "bad-date",
          periodEnd: "2025-12-31",
          beginningBalance: 1000,
          endingBalance: 5000, // breaks the self-check
        },
        bookRows: [
          { rowIndex: 1, date: "2025-13-40", type: "Check", checkNumber: null, payee: "x", payment: 50, deposit: 50, memo: "", amount: 0 },
        ],
      })
    );
    const msgs = errors.map((e) => e.message).join("\n");
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(msgs).toMatch(/Unsupported template_version/);
    expect(msgs).toMatch(/Client name is required/);
    expect(msgs).toMatch(/does not tie/);
    expect(msgs).toMatch(/Invalid date/);
    expect(msgs).toMatch(/both Payment and Deposit/);
    expect(msgs).toMatch(/Check # is missing/);
  });

  it("flags the statement self-check when it does not tie", () => {
    const { errors } = validateWorkbook(wb({ setup: { ...wb().setup, endingBalance: 950 } }));
    expect(errors.some((e) => /does not tie/.test(e.message))).toBe(true);
  });
});
