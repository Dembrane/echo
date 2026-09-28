/**
 * Canonical JSON and content hashes, version `c14n-v1`, byte for byte what the Python
 * analysis package computes, so hashes written by either stack keep matching: UTF-8,
 * keys sorted by code point, no insignificant whitespace, every string NFC-normalised,
 * floats as Python's shortest round-trip repr (so `1` and `1.0` differ), NaN and
 * infinities refused. Changing a rule is a new hash version, never an edit of this one.
 */

export const HASH_VERSION = "c14n-v1";

export class CanonicalizationError extends Error {}

/**
 * A number the Python side held as a float. JSON parsing cannot tell 1.0 from 1, so values
 * a schema declares as floats are wrapped: they hash as Python's float repr and serialise
 * as plain numbers everywhere else.
 */
export class PyFloat {
  constructor(readonly value: number) {}
  toJSON(): number {
    return this.value;
  }
  valueOf(): number {
    return this.value;
  }
}

/** Python's repr of a float: shortest round-trip digits, ".0" on integral values, exponents outside 1e-4..1e16. */
export function pyFloatRepr(x: number): string {
  if (!Number.isFinite(x))
    throw new CanonicalizationError("NaN and infinite floats have no canonical form");
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa = "", expText = "0"] = x.toExponential().split("e");
  const exp = Number(expText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = negative ? "-" : "";
  if (exp < -4 || exp >= 16) {
    const head = digits.slice(0, 1);
    const tail = digits.slice(1);
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${head}${tail ? `.${tail}` : ""}e${exp < 0 ? "-" : "+"}${e}`;
  }
  const point = exp + 1;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Python json.dumps string escaping with ensure_ascii=False. */
function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function encode(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new CanonicalizationError("NaN and infinite floats have no canonical form");
    if (Number.isInteger(value) && !Object.is(value, -0))
      // Beyond 2^53 JavaScript prints a rounded form; the exact integer is what Python prints.
      return Math.abs(value) < 2 ** 53 ? String(value) : BigInt(value).toString();
    return pyFloatRepr(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return quote(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (typeof value === "object") {
    const entries = new Map<string, unknown>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      const key = k.normalize("NFC");
      if (entries.has(key)) throw new CanonicalizationError(`two keys normalise to '${key}'`);
      entries.set(key, v);
    }
    const keys = [...entries.keys()].sort(byCodePoint);
    return `{${keys.map((k) => `${quote(k)}:${encode(entries.get(k))}`).join(",")}}`;
  }
  throw new CanonicalizationError(`${typeof value} has no canonical JSON form`);
}

export function canonicalJson(value: unknown): string {
  return encode(value);
}

export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** sha256 hex of the value's c14n-v1 JSON. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** A content hash over named parts, so adding a part never collides with an older tuple. */
export function fingerprint(parts: Record<string, unknown>): string {
  return contentHash(parts);
}
