import { createHmac } from "node:crypto";

/**
 * Python's json.dumps, byte for byte, because receivers verify our signature against the
 * bytes Python produced: ASCII-only output with \uXXXX escapes, Python float repr, and
 * either the default ", " / ": " separators or the compact ones.
 */
export function pythonJson(
  value: unknown,
  opts: { sortKeys?: boolean; compact?: boolean } = {},
): string {
  const [item, kv] = opts.compact ? [",", ":"] : [", ", ": "];
  const walk = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") return pyNumber(v);
    if (typeof v === "string") return pyString(v);
    if (Array.isArray(v)) return `[${v.map(walk).join(item)}]`;
    if (typeof v === "object") {
      const keys = Object.keys(v as object);
      if (opts.sortKeys) keys.sort(codePointCompare);
      return `{${keys
        .map((k) => `${pyString(k)}${kv}${walk((v as Record<string, unknown>)[k])}`)
        .join(item)}}`;
    }
    return pyString(String(v));
  };
  return walk(value);
}

function codePointCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

function pyString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i] as string;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Integers print bare; floats use Python's repr, which switches to exponent form outside [1e-4, 1e16). */
function pyNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error("NaN and Infinity are not valid JSON");
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    const [mant, exp = "0"] = n.toExponential().split("e");
    const e = Number(exp);
    return `${mant}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  return String(n);
}

/** HMAC-SHA256 over the sorted, compact JSON of the payload: `sha256=<hex>`. */
export function signature(payload: unknown, secret: string): string {
  const bytes = pythonJson(payload, { sortKeys: true, compact: true });
  return `sha256=${createHmac("sha256", secret).update(bytes, "utf8").digest("hex")}`;
}
