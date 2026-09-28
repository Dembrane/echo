/**
 * Python's round(x, n): the exact decimal value of the double, rounded half to even. Usage
 * figures pass through it in the old API, and Math.round would round ties up, so a shown
 * number could differ by one in its last digit.
 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const negative = x < 0;
  // toFixed(100) is the exact decimal expansion to 100 places, enough to see a true tie.
  const exact = Math.abs(x).toFixed(100);
  const [intPart = "0", frac = ""] = exact.split(".");
  const keep = frac.slice(0, ndigits);
  const rest = frac.slice(ndigits);
  let digits = BigInt(intPart + keep);
  const first = rest.charCodeAt(0) - 48;
  const tail = rest.slice(1);
  const roundUp = first > 5 || (first === 5 && (/[1-9]/.test(tail) || digits % 2n === 1n));
  if (roundUp) digits += 1n;
  const s = digits.toString().padStart(ndigits + 1, "0");
  const value = Number(ndigits ? `${s.slice(0, -ndigits)}.${s.slice(-ndigits)}` : s);
  return negative ? -value : value;
}

/** Python's int() on a float: truncation toward zero. */
export function pyInt(x: number | string | null | undefined): number {
  const n = typeof x === "string" ? Number(x) : (x ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** A Postgres numeric or float column as a JS number; null and junk read as 0. */
export function num(x: unknown): number {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : 0;
  return Number.isFinite(n) ? n : 0;
}
