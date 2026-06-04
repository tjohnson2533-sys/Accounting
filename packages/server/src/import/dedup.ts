import { createHash } from "node:crypto";
import { toCents } from "../money.js";

/**
 * Normalize a payee/description for matching and hashing. Bank descriptions are
 * noisy (`SQ *COFFEE 0123`, trailing store numbers); we uppercase, strip common
 * processor prefixes and punctuation, drop trailing digit runs, and collapse
 * whitespace so the same merchant hashes/keys consistently month to month.
 */
export function normalizePayee(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toUpperCase().trim();
  s = s.replace(/^(SQ|TST|SP|PP|POS|ACH|DEBIT|CREDIT)\s*\*+\s*/g, ""); // processor prefixes
  s = s.replace(/[*#]/g, " ");
  s = s.replace(/[^A-Z0-9 ]+/g, " "); // drop punctuation
  s = s.replace(/\s+\d{3,}\s*$/g, ""); // trailing store/location numbers
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Idempotency key for a generated transaction — the Excel analog of a bank FITID.
 * Overlapping re-uploads produce the same hash and are skipped.
 */
export function contentHash(input: {
  entityId: string;
  txnDate: string; // ISO yyyy-mm-dd
  signedAmount: number; // cents-significant
  payee: string | null | undefined;
  checkNumber: string | null | undefined;
}): string {
  const parts = [
    input.entityId,
    input.txnDate,
    String(toCents(input.signedAmount)),
    normalizePayee(input.payee),
    (input.checkNumber ?? "").trim(),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
