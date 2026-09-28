import { pyRound } from "@dembrane/legacy-shape";

/** Python's f"{x:.2f}": half-even on the exact value, like round(x, 2), then two decimals. */
export function money2(x: number): string {
  return pyRound(x, 2).toFixed(2);
}

/**
 * The account discount: `amount x (1 - pct/100)`, clamped to 0..100, rounded to cents.
 * One rule for every price path (Mollie charges, customer display, staff forecast).
 */
export function applyDiscount(amount: number, percentDiscount: number | null | undefined): number {
  if (!percentDiscount) return pyRound(amount, 2);
  const pct = Math.max(0, Math.min(100, Math.trunc(percentDiscount)));
  return pyRound(amount * (1 - pct / 100), 2);
}
