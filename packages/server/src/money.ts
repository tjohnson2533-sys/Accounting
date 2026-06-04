// Money helpers. Postings are numeric(14,2); JS floats are unsafe for accumulation,
// so every sum is done in integer cents and rounded back. Tolerance matches the DB
// balance trigger (0.005).

export const TOLERANCE = 0.005;

/** Round a money value to 2 decimal places (cent precision). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Convert a money value to integer cents. */
export function toCents(n: number): number {
  return Math.round(n * 100);
}

/** Sum money values exactly by accumulating in integer cents. */
export function sumAmounts(amounts: number[]): number {
  const cents = amounts.reduce((acc, n) => acc + toCents(n), 0);
  return cents / 100;
}

/** True when a residual is within the balance tolerance of zero. */
export function isZero(n: number): boolean {
  return Math.abs(n) <= TOLERANCE;
}

/** True when two money values are equal within tolerance. */
export function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE;
}
