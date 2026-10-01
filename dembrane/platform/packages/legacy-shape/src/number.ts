/**
 * Python's round(x, n) on a float: round half to even on the exact binary value. Every
 * amount sent to Mollie or shown on an invoice went through it, so a JavaScript
 * Math.round would move some charges by a cent (0.125 rounds to 0.12, 2.5 to 2).
 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x;
  // toFixed(100) prints the double's exact decimal expansion for every amount we handle.
  const exact = Math.abs(x).toFixed(100);
  const [intPart = "0", frac = ""] = exact.split(".");
  const keep = frac.slice(0, ndigits);
  const rest = frac.slice(ndigits);
  let digits = BigInt(intPart + keep);
  const first = rest[0] ?? "0";
  const tail = rest.slice(1);
  const roundUp =
    first > "5" ||
    (first === "5" && /[1-9]/.test(tail)) ||
    (first === "5" && !/[1-9]/.test(tail) && digits % 2n === 1n);
  if (roundUp) digits += 1n;
  const scaled = Number(digits) / 10 ** ndigits;
  return x < 0 ? -scaled : scaled;
}
