// Canonical domain types shared across the server modules.

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type TxnSource = "book_import" | "manual_je" | "bank_only";
export type LineMatch = "unmatched" | "matched" | "bank_only_booked" | "ignored";

/** A posting as supplied to the ledger; amount may be omitted (elided) for autobalance. */
export interface PostingInput {
  account_id: string;
  class_id?: string | null;
  amount?: number | null; // + debit / − credit; null = infer via autobalance
  check_number?: string | null;
  meta?: Record<string, unknown>;
}

/** A fully-resolved posting (amount present). */
export interface Posting extends PostingInput {
  amount: number;
}

/** Canonical parsed Setup tab. */
export interface ImportSetup {
  templateVersion: string;
  clientName: string;
  bankAccount: string;
  periodStart: string; // ISO yyyy-mm-dd
  periodEnd: string; // ISO yyyy-mm-dd
  beginningBalance: number;
  endingBalance: number;
}

/** Canonical Book-tab row (what the client wrote/made). */
export interface BookRow {
  rowIndex: number; // 1-based data row, for error reporting
  date: string; // ISO yyyy-mm-dd
  type: string; // "Check" | "Deposit" | "EFT" | ...
  checkNumber: string | null;
  payee: string;
  payment: number; // money out (0 if none)
  deposit: number; // money in (0 if none)
  memo: string;
  amount: number; // signed = deposit − payment
}

/** Canonical Statement-tab row (what cleared the bank). */
export interface StatementRow {
  rowIndex: number; // 1-based data row
  date: string; // ISO yyyy-mm-dd
  description: string;
  checkNumber: string | null;
  payment: number; // money out
  deposit: number; // money in
  memo: string;
  amount: number; // signed = deposit − payment (+ in / − out)
}

export interface ParsedWorkbook {
  setup: ImportSetup;
  bookRows: BookRow[];
  statementRows: StatementRow[];
}

export interface ValidationError {
  tab: "setup" | "book" | "statement";
  row: number | null; // null for setup-level / sheet-level problems
  message: string;
}

export interface ValidationResult {
  errors: ValidationError[];
  warnings: ValidationError[];
}
