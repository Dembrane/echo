/**
 * The Python behaviours popcorn's output depends on. The deck, the saved runs and the
 * settings JSON are compared byte for byte with what the Python API wrote, so truthiness,
 * str(), json.dumps and datetime.isoformat are reproduced here once.
 */

import { pySplit, pyStrip } from "./text";

export type Json = Record<string, unknown>;

export function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `v if isinstance(v, dict) else {}` */
export function dict(v: unknown): Json {
  return isRecord(v) ? v : {};
}

/** `v if isinstance(v, list) else []` */
export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Python truthiness for JSON values. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Python's str() for the JSON values popcorn holds. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return pyNumber(v);
  if (v instanceof Date) return pyIso(v);
  return pyJson(v);
}

/** `str(v or "")` */
export function orStr(v: unknown, fallback = ""): string {
  return truthy(v) ? pyStr(v) : fallback;
}

/** `_as_id`: a relation dict's id, or the value itself, as a string; None stays null. */
export function asId(v: unknown): string | null {
  const x = isRecord(v) ? v.id : v;
  return x === null || x === undefined ? null : pyStr(x);
}

/** `_as_id` in ticks.py: falsy ids are None too. */
export function asIdTruthy(v: unknown): string | null {
  const x = isRecord(v) ? v.id : v;
  return truthy(x) ? pyStr(x) : null;
}

/** Python repr of a float or int as json.dumps writes it. */
export function pyNumber(n: number): string {
  if (Number.isInteger(n) && !Object.is(n, -0) && Math.abs(n) < 1e16) return String(n);
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : n < 0 ? "-Infinity" : "NaN";
  // repr(float): shortest round-trip digits, exponent past 1e16 or below 1e-4.
  const s = String(n);
  const m = /^(-?)(\d+(?:\.\d+)?)e([+-])(\d+)$/.exec(s);
  if (m) {
    const [, sign, mant, esign, exp] = m;
    return `${sign}${mant}e${esign}${(exp ?? "").padStart(2, "0")}`;
  }
  if (Math.abs(n) >= 1e16) {
    const [mant, exp] = n.toExponential().split("e");
    const e = Number(exp);
    return `${mant}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  return s.includes(".") ? s : `${s}.0`;
}

/** A float that stays a float in Python: 1 is 1.0 there. */
export class PyFloat {
  constructor(readonly value: number) {}
}

/**
 * json.dumps(v, ensure_ascii=False) with Python's default separators, keys in insertion
 * order. A PyFloat prints with its decimal point.
 */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof PyFloat) {
    const s = pyNumber(v.value);
    return /[.eEna]/.test(s) ? s : `${s}.0`;
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyNumber(v);
  // JSON.stringify escapes exactly what json.dumps(ensure_ascii=False) does.
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(pyIso(v));
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  const parts = Object.entries(v as Json)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`);
  return `{${parts.join(", ")}}`;
}

/**
 * round(x, digits) as Python computes it: on the exact binary value of the float, halves
 * to even, then the float nearest that decimal.
 */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let e: number;
  if (exponent === 0) e = -1074;
  else {
    mantissa |= 1n << 52n;
    e = exponent - 1075;
  }
  // |x| = mantissa * 2^e = num / den
  let num = mantissa;
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den <<= BigInt(-e);
  const scale = 10n ** BigInt(digits);
  const scaled = num * scale;
  let q = scaled / den;
  const r2 = (scaled % den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  const out = Number(`${q}e-${digits}`);
  return negative ? -out : out;
}

/** datetime.isoformat() of an aware UTC time: microseconds only when non-zero, +00:00. */
export function pyIso(d: Date, micros = 0): string {
  const base = d.toISOString().replace(/\.\d{3}Z$/, "");
  const us = d.getUTCMilliseconds() * 1000 + micros;
  return `${base}${us ? `.${String(us).padStart(6, "0")}` : ""}+00:00`;
}

/** datetime.now(timezone.utc).isoformat(): the Python clock has microseconds. */
export function utcNowIso(now: Date = new Date()): string {
  return pyIso(now, now.getUTCMilliseconds() === 0 ? 1 : 0);
}

/**
 * Parses an ISO timestamp the way `datetime.fromisoformat` does for the forms stored here
 * (a naive one is UTC). Null when it does not parse.
 */
export function parseDt(v: unknown): Date | null {
  if (!truthy(v)) return null;
  if (v instanceof Date) return v;
  let text = String(v).replace("Z", "+00:00");
  text = text.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  if (!/[+-]\d{2}:\d{2}$/.test(text)) text = `${text}+00:00`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A timestamptz as Directus printed it: 2026-09-27T15:41:55.247Z. */
export function directusTime(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = parseDt(v);
  return d ? d.toISOString() : String(v);
}

/** `" ".join(text.split())` */
export function normalizeWs(s: string): string {
  return pySplit(s).join(" ");
}

/** Python's str.strip(). */
export function strip(s: string): string {
  return pyStrip(s);
}

/** Python slicing by code point: s[:n]. */
export function cpSlice(s: string, end: number): string {
  const cps = [...s];
  return cps.length <= end ? s : cps.slice(0, end).join("");
}

export function cpLength(s: string): number {
  return [...s].length;
}

/** `list(dict.fromkeys(xs))`: first occurrence wins, order kept. */
export function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/** Python equality for JSON values (dict order does not count, list order does). */
export function pyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") {
    // True == 1 in Python.
    const na = typeof a === "boolean" ? Number(a) : a;
    const nb = typeof b === "boolean" ? Number(b) : b;
    return na === nb;
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => pyEqual(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b && pyEqual(a[k], b[k]));
  }
  return false;
}
