import { approxEqual, sumAmounts } from "../money.js";
import type {
  BookRow,
  ParsedWorkbook,
  StatementRow,
  ValidationError,
  ValidationResult,
} from "../types.js";

// The shipped template (LedgerPro_Import_Template_v1.xlsx) carries version "1.0";
// "v1" is also accepted for hand-built fixtures.
export const SUPPORTED_TEMPLATE_VERSIONS = ["1.0", "v1"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Exactly one of Payment/Deposit must be > 0. */
function paymentDepositError(payment: number, deposit: number): string | null {
  const p = payment > 0;
  const d = deposit > 0;
  if (p && d) return "Row has both Payment and Deposit; exactly one is allowed";
  if (!p && !d) return "Row has neither Payment nor Deposit; one is required";
  if (payment < 0 || deposit < 0) return "Payment/Deposit cannot be negative";
  return null;
}

/**
 * Validator battery. Accumulates EVERY problem (never fails fast) with tab+row
 * references so a staffer can fix the sheet in a single pass.
 */
export function validateWorkbook(wb: ParsedWorkbook): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const { setup, bookRows, statementRows } = wb;

  // ----- Setup tab -----
  if (!SUPPORTED_TEMPLATE_VERSIONS.includes(setup.templateVersion)) {
    errors.push({
      tab: "setup",
      row: null,
      message: `Unsupported template_version "${setup.templateVersion}"`,
    });
  }
  if (!setup.clientName) errors.push({ tab: "setup", row: null, message: "Client name is required" });
  if (!setup.bankAccount) errors.push({ tab: "setup", row: null, message: "Bank account is required" });
  if (!validDate(setup.periodStart))
    errors.push({ tab: "setup", row: null, message: "Period start is missing or not a valid date" });
  if (!validDate(setup.periodEnd))
    errors.push({ tab: "setup", row: null, message: "Period end is missing or not a valid date" });

  // Statement self-check: beginning + Σ(signed statement amounts) = ending.
  const stmtNet = sumAmounts(statementRows.map((r) => r.amount));
  if (!approxEqual(setup.beginningBalance + stmtNet, setup.endingBalance)) {
    errors.push({
      tab: "setup",
      row: null,
      message:
        `Statement does not tie: beginning ${setup.beginningBalance} + net ${stmtNet} ` +
        `= ${setup.beginningBalance + stmtNet}, expected ending ${setup.endingBalance}`,
    });
  }

  // ----- Per-row checks -----
  const checkRow = (tab: "book" | "statement", r: BookRow | StatementRow) => {
    if (!validDate(r.date))
      errors.push({ tab, row: r.rowIndex, message: `Invalid date "${r.date}"` });
    const pd = paymentDepositError(r.payment, r.deposit);
    if (pd) errors.push({ tab, row: r.rowIndex, message: pd });
    if (Math.abs(r.amount) <= 0)
      errors.push({ tab, row: r.rowIndex, message: "Amount must be greater than zero" });
  };

  for (const r of bookRows) {
    checkRow("book", r);
    // Book tab carries Type; a Check requires a check number.
    if (r.type?.toLowerCase() === "check" && !r.checkNumber) {
      errors.push({ tab: "book", row: r.rowIndex, message: "Type is Check but Check # is missing" });
    }
  }
  for (const r of statementRows) checkRow("statement", r);

  return { errors, warnings };
}
