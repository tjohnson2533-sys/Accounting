import { round2 } from "../money.js";
import type { BookRow, ImportSetup, ParsedWorkbook, StatementRow } from "../types.js";

// The v1 template (LedgerPro_Import_Template_v1.xlsx) layout — Build Doc §4.
//   Setup tab:     key/value rows in columns A/B (field name, value).
//   Book tab:      header row, then: Date, Type, Check #, Payee/Description, Payment, Deposit, Memo
//   Statement tab: header row, then: Date, Description, Check #, Payment, Deposit, Memo
// parse* functions take already-extracted row arrays so they're testable without a file;
// loadWorkbookFile() adapts a real .xlsx via SheetJS.

export type Cell = string | number | boolean | null | undefined;
export type SheetRows = Cell[][];

export interface RawWorkbook {
  setup: SheetRows;
  book: SheetRows;
  statement: SheetRows;
}

function toNum(v: Cell): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return round2(v);
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isNaN(n) ? 0 : round2(n);
}

function toStr(v: Cell): string {
  if (v == null) return "";
  return String(v).trim();
}

/** Excel serial date or string → ISO yyyy-mm-dd (best effort; validation catches bad ones). */
function toISODate(v: Cell): string {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    // Excel serial date (1900 epoch); 25569 days from 1900-01-01 to 1970-01-01.
    const ms = Math.round((v - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

// The Setup tab pairs a verbose label in column A with its value in column B
// (column C may hold a note). Labels are matched by keyword so the parser is robust
// to the exact wording ("Client / Entity", "Bank Account (name or last 4)", etc.) and
// ignores the computed SELF-CHECK / BOOK-vs-STATEMENT blocks lower on the sheet.
function findSetupValue(rows: SheetRows, keyword: string): Cell {
  for (const row of rows) {
    const value = row?.[1];
    if (value == null || value === "") continue; // skip title/instruction rows (no value cell)
    const label = toStr(row?.[0]).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (label.includes(keyword)) return value;
  }
  return undefined;
}

export function parseSetup(rows: SheetRows): ImportSetup {
  return {
    templateVersion: toStr(findSetupValue(rows, "template version")) || "",
    clientName: toStr(findSetupValue(rows, "client")),
    bankAccount: toStr(findSetupValue(rows, "bank account")),
    periodStart: toISODate(findSetupValue(rows, "period start")),
    periodEnd: toISODate(findSetupValue(rows, "period end")),
    beginningBalance: toNum(findSetupValue(rows, "beginning balance")),
    endingBalance: toNum(findSetupValue(rows, "ending balance")),
  };
}

/** Skip a header row if the first cell isn't a date. */
function dataRows(rows: SheetRows): { row: SheetRows[number]; rowIndex: number }[] {
  const out: { row: SheetRows[number]; rowIndex: number }[] = [];
  let dataIdx = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c == null || c === "")) continue;
    const firstIsHeader = i === 0 && typeof row[0] === "string" && !/^\d/.test(String(row[0]));
    if (firstIsHeader) continue;
    dataIdx += 1;
    out.push({ row, rowIndex: dataIdx });
  }
  return out;
}

export function parseBook(rows: SheetRows): BookRow[] {
  // Columns: Date, Type, Check #, Payee/Description, Payment, Deposit, Memo
  return dataRows(rows).map(({ row, rowIndex }) => {
    const payment = toNum(row[4]);
    const deposit = toNum(row[5]);
    return {
      rowIndex,
      date: toISODate(row[0]),
      type: toStr(row[1]),
      checkNumber: toStr(row[2]) || null,
      payee: toStr(row[3]),
      payment,
      deposit,
      memo: toStr(row[6]),
      amount: round2(deposit - payment),
    };
  });
}

export function parseStatement(rows: SheetRows): StatementRow[] {
  // Columns: Date, Description, Check #, Payment, Deposit, Memo
  return dataRows(rows).map(({ row, rowIndex }) => {
    const payment = toNum(row[3]);
    const deposit = toNum(row[4]);
    return {
      rowIndex,
      date: toISODate(row[0]),
      description: toStr(row[1]),
      checkNumber: toStr(row[2]) || null,
      payment,
      deposit,
      memo: toStr(row[5]),
      amount: round2(deposit - payment),
    };
  });
}

export function parseWorkbook(raw: RawWorkbook): ParsedWorkbook {
  return {
    setup: parseSetup(raw.setup),
    bookRows: parseBook(raw.book),
    statementRows: parseStatement(raw.statement),
  };
}

/** Adapter: read a real .xlsx file into RawWorkbook (SheetJS). Sheets matched case-insensitively. */
export async function loadWorkbookFile(buffer: Buffer): Promise<ParsedWorkbook> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const pick = (name: string): SheetRows => {
    const sheetName = wb.SheetNames.find((n) => n.toLowerCase().includes(name));
    if (!sheetName) return [];
    return XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
  };
  return parseWorkbook({ setup: pick("setup"), book: pick("book"), statement: pick("statement") });
}
