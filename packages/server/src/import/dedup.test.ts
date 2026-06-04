import { describe, expect, it } from "vitest";
import { contentHash, normalizePayee } from "./dedup.js";

describe("normalizePayee", () => {
  it("strips processor prefixes, punctuation, and trailing store numbers", () => {
    expect(normalizePayee("SQ *COFFEE 0123")).toBe("COFFEE");
    expect(normalizePayee("TST* Joe's Diner #45  9981")).toBe("JOE S DINER 45");
    expect(normalizePayee("  amazon.com*A1B2  ")).toBe("AMAZON COM A1B2");
  });

  it("returns empty for blank input", () => {
    expect(normalizePayee(null)).toBe("");
    expect(normalizePayee("")).toBe("");
  });
});

describe("contentHash", () => {
  const base = {
    entityId: "e1",
    txnDate: "2025-12-01",
    signedAmount: -100,
    payee: "ACME",
    checkNumber: "1001",
  };

  it("is stable for identical inputs (idempotent re-upload)", () => {
    expect(contentHash(base)).toBe(contentHash({ ...base }));
  });

  it("ignores payee noise that normalizes away", () => {
    expect(contentHash({ ...base, payee: "ACME 0123" })).toBe(contentHash({ ...base, payee: "ACME" }));
  });

  it("differs when a salient field changes", () => {
    expect(contentHash(base)).not.toBe(contentHash({ ...base, signedAmount: -101 }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, checkNumber: "1002" }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, txnDate: "2025-12-02" }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, entityId: "e2" }));
  });
});
