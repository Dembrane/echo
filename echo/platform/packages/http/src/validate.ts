import { ValidationError } from "@echo/core";
import type { Context } from "hono";

/**
 * Request validation that answers exactly like FastAPI with pydantic 2.12: status 422 and
 * `{ detail: [{ type, loc, msg, input, ctx?, url? }] }`, every failing field in declaration
 * order. The dashboard, portal and iOS app show these messages, so the shape stays until
 * the unified error contract replaces it.
 */

type Loc = (string | number)[];

export interface Issue {
  readonly type: string;
  readonly loc: Loc;
  readonly msg: string;
  readonly input: unknown;
  readonly ctx?: Record<string, unknown>;
  readonly url?: string;
}

const PYDANTIC_URL = "https://errors.pydantic.dev/2.12/v/";

function issue(
  type: string,
  loc: Loc,
  msg: string,
  input: unknown,
  ctx?: Record<string, unknown>,
  withUrl = true,
): Issue {
  return {
    type,
    loc,
    msg,
    input,
    ...(ctx && { ctx }),
    ...(withUrl && { url: `${PYDANTIC_URL}${type}` }),
  };
}

/** One field: turns raw input into a value or reports issues at `loc`. */
export interface Field<T> {
  readonly parse: (input: unknown, loc: Loc, issues: Issue[]) => T | typeof INVALID;
  /** Present when the field may be absent; the value it takes then. */
  readonly fallback?: { readonly value: T };
}

export const INVALID = Symbol("invalid");

type Out<F> = F extends Field<infer T> ? T : never;

export function str(opts: { min?: number; max?: number } = {}): Field<string> {
  return {
    parse(input, loc, issues) {
      if (typeof input !== "string") {
        issues.push(issue("string_type", loc, "Input should be a valid string", input));
        return INVALID;
      }
      const len = [...input].length;
      if (opts.min !== undefined && len < opts.min) {
        issues.push(
          issue(
            "string_too_short",
            loc,
            `String should have at least ${opts.min} character${opts.min === 1 ? "" : "s"}`,
            input,
            { min_length: opts.min },
          ),
        );
        return INVALID;
      }
      if (opts.max !== undefined && len > opts.max) {
        issues.push(
          issue(
            "string_too_long",
            loc,
            `String should have at most ${opts.max} character${opts.max === 1 ? "" : "s"}`,
            input,
            { max_length: opts.max },
          ),
        );
        return INVALID;
      }
      return input;
    },
  };
}

const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

/** Pydantic's lax boolean: JSON booleans, 0 and 1, and the usual yes/no words. */
export function bool(): Field<boolean> {
  return {
    parse(input, loc, issues) {
      if (typeof input === "boolean") return input;
      if (input === 0 || input === 1) return input === 1;
      if (typeof input === "string") {
        const v = input.trim().toLowerCase();
        if (TRUE.has(v)) return true;
        if (FALSE.has(v)) return false;
      }
      if (typeof input === "string" || typeof input === "number") {
        issues.push(
          issue(
            "bool_parsing",
            loc,
            "Input should be a valid boolean, unable to interpret input",
            input,
          ),
        );
      } else {
        issues.push(issue("bool_type", loc, "Input should be a valid boolean", input));
      }
      return INVALID;
    },
  };
}

/** Pydantic's lax integer: whole numbers, and strings of digits (query parameters). */
export function int(): Field<number> {
  return {
    parse(input, loc, issues) {
      if (typeof input === "number" && Number.isInteger(input)) return input;
      if (typeof input === "number") {
        issues.push(
          issue(
            "int_from_float",
            loc,
            "Input should be a valid integer, got a number with a fractional part",
            input,
          ),
        );
        return INVALID;
      }
      if (typeof input === "string") {
        const t = input.trim();
        if (/^[+-]?\d+$/.test(t)) return Number.parseInt(t, 10);
        issues.push(
          issue(
            "int_parsing",
            loc,
            "Input should be a valid integer, unable to parse string as an integer",
            input,
          ),
        );
        return INVALID;
      }
      issues.push(issue("int_type", loc, "Input should be a valid integer", input));
      return INVALID;
    },
  };
}

export function dict(): Field<Record<string, unknown>> {
  return {
    parse(input, loc, issues) {
      if (input !== null && typeof input === "object" && !Array.isArray(input))
        return input as Record<string, unknown>;
      issues.push(issue("dict_type", loc, "Input should be a valid dictionary", input));
      return INVALID;
    },
  };
}

export function list<T>(item: Field<T>): Field<T[]> {
  return {
    parse(input, loc, issues) {
      if (!Array.isArray(input)) {
        issues.push(issue("list_type", loc, "Input should be a valid list", input));
        return INVALID;
      }
      const out: T[] = [];
      let bad = false;
      input.forEach((v, i) => {
        const r = item.parse(v, [...loc, i], issues);
        if (r === INVALID) bad = true;
        else out.push(r);
      });
      return bad ? INVALID : out;
    },
  };
}

/** Python's `" or ".join` style: 'a', 'b' or 'c'. */
function expected(values: readonly string[]): string {
  const quoted = values.map((v) => `'${v}'`);
  return quoted.length <= 1
    ? (quoted[0] ?? "")
    : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
}

export function literal<const V extends string>(values: readonly V[]): Field<V> {
  return {
    parse(input, loc, issues) {
      if (typeof input === "string" && (values as readonly string[]).includes(input))
        return input as V;
      const e = expected(values);
      issues.push(issue("literal_error", loc, `Input should be ${e}`, input, { expected: e }));
      return INVALID;
    },
  };
}

/**
 * pydantic's EmailStr (email-validator syntax checks, no deliverability lookup). Returns
 * the address with its domain lowercased, as pydantic's normalisation does.
 */
export function email(): Field<string> {
  return {
    parse(input, loc, issues) {
      if (typeof input !== "string") {
        issues.push(issue("string_type", loc, "Input should be a valid string", input));
        return INVALID;
      }
      const reason = emailProblem(input);
      if (reason) {
        issues.push(
          issue(
            "value_error",
            loc,
            `value is not a valid email address: ${reason}`,
            input,
            { reason },
            false,
          ),
        );
        return INVALID;
      }
      const at = input.lastIndexOf("@");
      return `${input.slice(0, at)}@${input.slice(at + 1).toLowerCase()}`;
    },
  };
}

const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\u0080-￿]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9\u0080-￿](?:[A-Za-z0-9\u0080-￿-]*[A-Za-z0-9\u0080-￿])?$/;

function emailProblem(value: string): string | null {
  if (value.length > 2048) return "Length must not exceed 2048 characters";
  const at = value.lastIndexOf("@");
  if (at < 0) return "An email address must have an @-sign.";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local) return "There must be something before the @-sign.";
  if (!domain) return "There must be something after the @-sign.";
  const bad = [...new Set([...local].filter((ch) => ch !== "." && !LOCAL_ATOM.test(ch)))];
  if (bad.length)
    return `The email address contains invalid characters before the @-sign: ${bad.map((c) => (c === " " ? "SPACE" : `'${c}'`)).join(", ")}.`;
  if (local.startsWith(".")) return "An email address cannot start with a period.";
  if (local.endsWith("."))
    return "An email address cannot have a period immediately before the @-sign.";
  if (local.includes("..")) return "An email address cannot have two periods in a row.";
  const badDomain = [...new Set([...domain].filter((ch) => !/[A-Za-z0-9.\-\u0080-￿]/.test(ch)))];
  if (badDomain.length)
    return `The part after the @-sign contains invalid characters: ${badDomain.map((c) => (c === " " ? "SPACE" : `'${c}'`)).join(", ")}.`;
  if (domain.startsWith("."))
    return "An email address cannot have a period immediately after the @-sign.";
  if (domain.endsWith(".")) return "An email address cannot end with a period.";
  if (domain.includes("..")) return "An email address cannot have two periods in a row.";
  if (!domain.includes("."))
    return "The part after the @-sign is not valid. It should have a period.";
  if (!domain.split(".").every((l) => DOMAIN_LABEL.test(l)))
    return "The part after the @-sign is not valid IDNA: an invalid character or hyphen placement.";
  return null;
}

export function any(): Field<unknown> {
  return { parse: (input) => input };
}

/** Absent or null gives `fallback`; otherwise the inner field decides. */
export function optional<T, D extends T | null = null>(
  inner: Field<T>,
  fallback: D = null as D,
): Field<T | D> {
  return {
    parse: (input, loc, issues) => (input === null ? fallback : inner.parse(input, loc, issues)),
    fallback: { value: fallback },
  };
}

/** Absent gives `value`; present values go through the inner field (null included). */
export function withDefault<T>(inner: Field<T>, value: T): Field<T> {
  return { parse: inner.parse, fallback: { value } };
}

/** A pydantic `field_validator` that raises ValueError: reported as "Value error, <msg>". */
export function refine<T>(inner: Field<T>, check: (v: T) => string | null): Field<T> {
  return {
    ...inner,
    parse(input, loc, issues) {
      const v = inner.parse(input, loc, issues);
      if (v === INVALID) return INVALID;
      const problem = check(v);
      if (problem) {
        issues.push(issue("value_error", loc, `Value error, ${problem}`, input, { error: {} }));
        return INVALID;
      }
      return v;
    },
  };
}

export type Shape = Record<string, Field<unknown>>;
export type Parsed<S extends Shape> = { [K in keyof S]: Out<S[K]> };

function parseFields<S extends Shape>(
  shape: S,
  source: Record<string, unknown>,
  loc: Loc,
  issues: Issue[],
  missingInput: unknown,
): Parsed<S> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(shape)) {
    if (!(name in source) || source[name] === undefined) {
      if (field.fallback) out[name] = field.fallback.value;
      else issues.push(issue("missing", [...loc, name], "Field required", missingInput));
      continue;
    }
    const v = field.parse(source[name], [...loc, name], issues);
    if (v !== INVALID) out[name] = v;
  }
  return out as Parsed<S>;
}

function fail(issues: Issue[]): never {
  throw new ValidationError("Request validation failed", issues);
}

/**
 * Checks, in FastAPI's order (query parameters, then the JSON body), and throws one 422
 * listing every problem. Call after the route's authentication and access dependencies,
 * which FastAPI resolves first.
 */
export async function validate<Q extends Shape, B extends Shape>(
  c: Context,
  spec: { query?: Q; body?: B },
): Promise<{ query: Parsed<Q>; body: Parsed<B> }> {
  const issues: Issue[] = [];
  let query = {} as Parsed<Q>;
  if (spec.query) {
    const raw = c.req.query();
    query = parseFields(spec.query, raw, ["query"], issues, null);
  }
  let body = {} as Parsed<B>;
  if (spec.body) {
    const raw = await readJson(c);
    if (raw === undefined) {
      issues.push(issue("missing", ["body"], "Field required", null));
    } else if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(
        issue(
          "model_attributes_type",
          ["body"],
          "Input should be a valid dictionary or object to extract fields from",
          raw,
        ),
      );
    } else {
      body = parseFields(spec.body, raw as Record<string, unknown>, ["body"], issues, raw);
    }
  }
  if (issues.length) fail(issues);
  return { query, body };
}

/** The JSON body, or undefined when there is none. Invalid JSON is FastAPI's json_invalid. */
async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    fail([
      issue(
        "json_invalid",
        ["body", 0],
        "JSON decode error",
        {},
        { error: "Expecting value" },
        false,
      ),
    ]);
  }
}
