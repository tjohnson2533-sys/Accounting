import { describe, expect, it } from "vitest";
import { approxEqual, isZero, round2, sumAmounts, toCents } from "./money.js";

describe("money", () => {
  it("sums exactly via integer cents (no float drift)", () => {
    // 0.1 + 0.2 !== 0.3 in float; cents accumulation fixes it.
    expect(sumAmounts([0.1, 0.2])).toBe(0.3);
    expect(sumAmounts([100.1, 200.2, -300.3])).toBe(0);
    expect(sumAmounts([1.005, 2.005])).toBe(round2(toCents(1.005) / 100 + toCents(2.005) / 100));
  });

  it("isZero respects the 0.005 tolerance", () => {
    expect(isZero(0)).toBe(true);
    expect(isZero(0.004)).toBe(true);
    expect(isZero(0.006)).toBe(false);
  });

  it("approxEqual compares within tolerance", () => {
    expect(approxEqual(10.0, 10.004)).toBe(true);
    expect(approxEqual(10.0, 10.01)).toBe(false);
  });
});
