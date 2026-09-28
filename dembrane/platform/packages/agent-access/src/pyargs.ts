/**
 * MCP tool arguments validated the way the Python SDK validated them (a pydantic model per
 * tool, lax mode), with the same error text. Agents read that text to correct a call, and
 * connected clients were built against it, so it is part of the contract. Covers the
 * parameter kinds the dembrane tools use: required and optional strings, integers with a
 * default, optional booleans and string literals.
 */

export type Param =
  | { readonly name: string; readonly kind: "str" }
  | { readonly name: string; readonly kind: "optstr" }
  | { readonly name: string; readonly kind: "optbool" }
  | { readonly name: string; readonly kind: "int"; readonly default: number }
  | {
      readonly name: string;
      readonly kind: "literal";
      readonly values: readonly string[];
      readonly default: string;
    };

type Issue = { loc: string; msg: string; type: string; input: unknown };

export class ArgumentError extends Error {
  override readonly name = "ArgumentError";
}

/** A pydantic field title: "project_id" becomes "Project Id". */
export const title = (name: string) =>
  name
    .split("_")
    .map((w) => (w ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ");

/** The JSON schema pydantic generated for a tool's argument model, key order included. */
export function inputSchema(tool: string, params: readonly Param[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    const t = title(p.name);
    switch (p.kind) {
      case "str":
        properties[p.name] = { title: t, type: "string" };
        required.push(p.name);
        break;
      case "optstr":
        properties[p.name] = {
          anyOf: [{ type: "string" }, { type: "null" }],
          default: null,
          title: t,
        };
        break;
      case "optbool":
        properties[p.name] = {
          anyOf: [{ type: "boolean" }, { type: "null" }],
          default: null,
          title: t,
        };
        break;
      case "int":
        properties[p.name] = { default: p.default, title: t, type: "integer" };
        break;
      case "literal":
        properties[p.name] = { default: p.default, enum: [...p.values], title: t, type: "string" };
        break;
    }
  }
  return {
    properties,
    ...(required.length && { required }),
    type: "object",
    title: `${tool}Arguments`,
  };
}

/** Python's repr() of a JSON value, which pydantic prints as input_value. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return pyStr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${pyStr(k)}: ${pyRepr(x)}`)
      .join(", ")}}`;
  return String(v);
}

function pyStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

function pyType(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** pydantic shortens a long input_value to its head and tail. */
function shortRepr(v: unknown): string {
  const r = pyRepr(v);
  return r.length > 50 ? `${r.slice(0, 25)}...${r.slice(-24)}` : r;
}

const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

function parseInt_(v: unknown, loc: string, issues: Issue[]): number | undefined {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v;
    issues.push({
      loc,
      type: "int_from_float",
      msg: "Input should be a valid integer, got a number with a fractional part",
      input: v,
    });
    return undefined;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (/^[+-]?\d+$/.test(t)) return Number.parseInt(t, 10);
    issues.push({
      loc,
      type: "int_parsing",
      msg: "Input should be a valid integer, unable to parse string as an integer",
      input: v,
    });
    return undefined;
  }
  issues.push({ loc, type: "int_type", msg: "Input should be a valid integer", input: v });
  return undefined;
}

function parseBool(v: unknown, loc: string, issues: Issue[]): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (TRUE.has(t)) return true;
    if (FALSE.has(t)) return false;
  }
  if (typeof v === "string" || typeof v === "number")
    issues.push({
      loc,
      type: "bool_parsing",
      msg: "Input should be a valid boolean, unable to interpret input",
      input: v,
    });
  else issues.push({ loc, type: "bool_type", msg: "Input should be a valid boolean", input: v });
  return undefined;
}

/**
 * The SDK's pre_parse_json: a string given for a field not annotated plain `str` is tried
 * as JSON, and replaced when it decodes to null, a list or an object (Claude Desktop sends
 * lists and objects as JSON text).
 */
function preParse(p: Param, v: unknown): unknown {
  if (typeof v !== "string" || p.kind === "str") return v;
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed === null || typeof parsed === "object" ? parsed : v;
  } catch {
    return v;
  }
}

/** Validated arguments, or an ArgumentError whose message is pydantic's. */
export function validateArgs(
  tool: string,
  params: readonly Param[],
  args: Record<string, unknown>,
): Record<string, unknown> {
  const issues: Issue[] = [];
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (!(p.name in args)) {
      if (p.kind === "str")
        issues.push({ loc: p.name, type: "missing", msg: "Field required", input: args });
      else out[p.name] = p.kind === "optstr" || p.kind === "optbool" ? null : p.default;
      continue;
    }
    const v = preParse(p, args[p.name]);
    switch (p.kind) {
      case "str":
      case "optstr":
        if (typeof v === "string" || (v === null && p.kind === "optstr")) out[p.name] = v;
        else
          issues.push({
            loc: p.name,
            type: "string_type",
            msg: "Input should be a valid string",
            input: v,
          });
        break;
      case "optbool":
        if (v === null) out[p.name] = null;
        else {
          const b = parseBool(v, p.name, issues);
          if (b !== undefined) out[p.name] = b;
        }
        break;
      case "int": {
        const n = parseInt_(v, p.name, issues);
        if (n !== undefined) out[p.name] = n;
        break;
      }
      case "literal":
        if (typeof v === "string" && p.values.includes(v)) out[p.name] = v;
        else
          issues.push({
            loc: p.name,
            type: "literal_error",
            msg: `Input should be ${literalList(p.values)}`,
            input: v,
          });
        break;
    }
  }
  if (issues.length) {
    const head = `${issues.length} validation error${issues.length === 1 ? "" : "s"} for ${tool}Arguments`;
    const body = issues.map(
      (i) =>
        `${i.loc}\n  ${i.msg} [type=${i.type}, input_value=${shortRepr(i.input)}, input_type=${pyType(i.input)}]\n    For further information visit https://errors.pydantic.dev/2.12/v/${i.type}`,
    );
    throw new ArgumentError([head, ...body].join("\n"));
  }
  return out;
}

function literalList(values: readonly string[]): string {
  const q = values.map((v) => `'${v}'`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} or ${q.at(-1)}`;
}

/**
 * pydantic_core.to_json(indent=2), which the SDK used for a tool answer's text. It equals
 * JSON.stringify except that Python floats keep a fractional part: `duration` is the only
 * float field in any answer, so an integral duration prints as 12.0 there.
 */
export function pyJson(value: unknown): string {
  return JSON.stringify(
    value,
    (key, v) =>
      key === "duration" && typeof v === "number" && Number.isInteger(v) ? `${FLOAT}${v}` : v,
    2,
  ).replace(FLOAT_RE, "$1.0");
}

const FLOAT = "__pyfloat__";
const FLOAT_RE = /"__pyfloat__(-?\d+)"/g;
