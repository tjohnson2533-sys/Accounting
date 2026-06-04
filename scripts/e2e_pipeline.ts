// Exercises the real import pipeline end-to-end on an actual .xlsx round-trip:
// build a filled workbook in the v1 template's layout -> SheetJS parse (loadWorkbookFile)
// -> validator battery -> book<->statement matcher. Run: npx tsx scripts/e2e_pipeline.ts
import * as XLSX from "xlsx";
import { loadWorkbookFile } from "../packages/server/src/import/parseWorkbook.js";
import { matchStatement, type UnclearedPosting } from "../packages/server/src/import/match.js";
import { validateWorkbook } from "../packages/server/src/import/validate.js";

const setup = [
  ["LedgerPro — Monthly Import Template"],
  [],
  ["Template Version", "1.0", "← do not edit"],
  [],
  ["Client / Entity", "Acme LLC"],
  ["Bank Account (name or last 4)", "Operating Checking"],
  ["Statement Period Start", "2025-12-01"],
  ["Statement Period End", "2025-12-31"],
  ["Statement Beginning Balance", 1000],
  ["Statement Ending Balance", 885],
];
const book = [
  ["Date", "Type", "Check #", "Payee / Description", "Payment", "Deposit", "Memo"],
  ["2025-12-05", "Check", "1001", "Landlord rent", 100, 0, "office"],
  ["2025-12-20", "Deposit", "", "Customer deposit", 0, 500, "inv 5"],
];
const statement = [
  ["Date", "Description", "Check #", "Payment", "Deposit", "Memo"],
  ["2025-12-06", "CHECK 1001", "1001", 100, 0, ""],
  ["2025-12-31", "SERVICE FEE", "", 15, 0, ""],
];

async function main() {
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(setup), "Setup");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(book), "Book");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(statement), "Statement");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

const parsed = await loadWorkbookFile(buf);
console.log("PARSE  :", JSON.stringify(parsed.setup));
console.log("        book rows:", parsed.bookRows.length, "statement rows:", parsed.statementRows.length);

const v = validateWorkbook(parsed);
console.log("VALIDATE:", v.errors.length === 0 ? "PASS (0 errors)" : `FAIL (${v.errors.length})`);
if (v.errors.length) console.log(v.errors);

// Standing set = the uncleared book cash-leg postings (what the matcher consumes).
const standing: UnclearedPosting[] = parsed.bookRows.map((r, i) => ({
  postingId: `p${i}`,
  transactionId: `t${i}`,
  date: r.date,
  amount: r.amount,
  checkNumber: r.checkNumber,
}));
const m = matchStatement(parsed.statementRows, standing);
const counts = m.results.reduce<Record<string, number>>((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {});
console.log("MATCH  :", JSON.stringify(counts), "(cleared:", m.cleared.length, "bank-only:", m.bankOnly.length, ")");
m.results.forEach((r) =>
  console.log(`         line ${r.lineRowIndex}: ${r.outcome}${r.matchedPostingId ? " -> " + r.matchedPostingId : ""}`)
);

const ok = v.errors.length === 0 && counts.matched === 1 && counts.bank_only === 1 && !counts.unmatched;
console.log(ok ? "\nPIPELINE E2E: PASS" : "\nPIPELINE E2E: FAIL");
process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
