import { ValidationError } from "@echo/core";

/**
 * Request validation that answers exactly like FastAPI with pydantic 2.12 in lax mode:
 * the same coercions, the same error list, in field declaration order. Clients and the
 * parity suite read these 422 bodies; the unified contract replaces them later.
 */

export type Loc = readonly (string | number)[];

export interface Issue {
  type: string;
  loc: Loc;
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
  url?: string;
}

const URL_BASE = "https://errors.pydantic.dev/2.12/v/";

function issue(
  type: string,
  loc: Loc,
  msg: string,
  input: unknown,
  ctx?: Record<string, unknown>,
): Issue {
  return { type, loc, msg, input, ...(ctx && { ctx }), url: `${URL_BASE}${type}` };
}

const FAIL: unique symbol = Symbol("fail");
type Out<T> = T | typeof FAIL;

export interface Type<T> {
  readonly parse: (v: unknown, loc: Loc, issues: Issue[]) => Out<T>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function str(opts: { min?: number; max?: number } = {}): Type<string> {
  return {
    parse(v, loc, issues) {
      if (typeof v !== "string") {
        issues.push(issue("string_type", loc, "Input should be a valid string", v));
        return FAIL;
      }
      // pydantic counts code points, not UTF-16 units.
      const len = [...v].length;
      if (opts.min !== undefined && len < opts.min) {
        issues.push(
          issue(
            "string_too_short",
            loc,
            `String should have at least ${opts.min} character${opts.min === 1 ? "" : "s"}`,
            v,
            { min_length: opts.min },
          ),
        );
        return FAIL;
      }
      if (opts.max !== undefined && len > opts.max) {
        issues.push(
          issue(
            "string_too_long",
            loc,
            `String should have at most ${opts.max} character${opts.max === 1 ? "" : "s"}`,
            v,
            { max_length: opts.max },
          ),
        );
        return FAIL;
      }
      return v;
    },
  };
}

export function int(opts: { ge?: number; le?: number } = {}): Type<number> {
  return {
    parse(v, loc, issues) {
      let n: number;
      if (typeof v === "boolean") n = v ? 1 : 0;
      else if (typeof v === "number") {
        if (!Number.isInteger(v)) {
          issues.push(
            issue(
              "int_from_float",
              loc,
              "Input should be a valid integer, got a number with a fractional part",
              v,
            ),
          );
          return FAIL;
        }
        n = v;
      } else if (typeof v === "string") {
        const t = v.trim();
        if (!/^[+-]?\d+(_\d+)*$/.test(t)) {
          issues.push(
            issue(
              "int_parsing",
              loc,
              "Input should be a valid integer, unable to parse string as an integer",
              v,
            ),
          );
          return FAIL;
        }
        n = Number(t.replaceAll("_", ""));
      } else {
        issues.push(issue("int_type", loc, "Input should be a valid integer", v));
        return FAIL;
      }
      if (opts.ge !== undefined && n < opts.ge) {
        issues.push(
          issue(
            "greater_than_equal",
            loc,
            `Input should be greater than or equal to ${opts.ge}`,
            v,
            {
              ge: opts.ge,
            },
          ),
        );
        return FAIL;
      }
      if (opts.le !== undefined && n > opts.le) {
        issues.push(
          issue("less_than_equal", loc, `Input should be less than or equal to ${opts.le}`, v, {
            le: opts.le,
          }),
        );
        return FAIL;
      }
      return n;
    },
  };
}

const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

export function bool(): Type<boolean> {
  return {
    parse(v, loc, issues) {
      if (typeof v === "boolean") return v;
      if (typeof v === "number" && (v === 0 || v === 1)) return v === 1;
      if (typeof v === "string") {
        const t = v.trim().toLowerCase();
        if (TRUE.has(t)) return true;
        if (FALSE.has(t)) return false;
      }
      if (typeof v === "string" || typeof v === "number") {
        issues.push(
          issue(
            "bool_parsing",
            loc,
            "Input should be a valid boolean, unable to interpret input",
            v,
          ),
        );
        return FAIL;
      }
      issues.push(issue("bool_type", loc, "Input should be a valid boolean", v));
      return FAIL;
    },
  };
}

// ── EmailStr, as the email-validator package behind it words its refusals ──

const SPECIAL_USE = new Set(["arpa", "invalid", "local", "localhost", "onion", "test"]);
const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.\u0080-\uFFFF]+$/;

/** The reason email-validator gives for the common mistakes, or null when the address is valid. */
export function emailProblem(email: string): string | null {
  if (email.length > 2048) return "Length must not exceed 2048 characters";
  const at = email.lastIndexOf("@");
  if (at < 0) return "An email address must have an @-sign.";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local) return "There must be something before the @-sign.";
  if (!domain) return "There must be something after the @-sign.";
  if (!LOCAL_ATOM.test(local)) {
    const bad = [...new Set([...local].filter((ch) => !LOCAL_ATOM.test(ch)))];
    return `The email address contains invalid characters before the @-sign: ${bad
      .map((c) => (c === " " ? "SPACE" : `'${c}'`))
      .join(", ")}.`;
  }
  if (local.startsWith(".")) return "An email address cannot start with a period.";
  if (local.endsWith("."))
    return "An email address cannot have a period immediately before the @-sign.";
  if (local.includes("..")) return "An email address cannot have two periods in a row.";
  const d = domain.toLowerCase();
  if (!/^[a-z0-9.\-\u0080-\uffff]+$/.test(d))
    return "The part after the @-sign contains invalid characters.";
  if (d.startsWith("."))
    return "An email address cannot have a period immediately after the @-sign.";
  if (d.endsWith(".")) return "An email address cannot end with a period.";
  if (d.includes("..")) return "An email address cannot have two periods in a row.";
  if (!d.includes(".")) return "The part after the @-sign is not valid. It should have a period.";
  const tld = d.slice(d.lastIndexOf(".") + 1);
  if (SPECIAL_USE.has(tld) || SPECIAL_USE.has(d))
    return "The part after the @-sign is a special-use or reserved name that cannot be used with email.";
  if (/^\d+$/.test(tld)) return "The part after the @-sign is not valid IDNA.";
  return null;
}

/** pydantic's EmailStr: a value_error without a docs url, and the domain lowercased on success. */
export function email(): Type<string> {
  return {
    parse(v, loc, issues) {
      if (typeof v !== "string") {
        issues.push(issue("string_type", loc, "Input should be a valid string", v));
        return FAIL;
      }
      const reason = emailProblem(v);
      if (reason) {
        issues.push({
          type: "value_error",
          loc,
          msg: `value is not a valid email address: ${reason}`,
          input: v,
          ctx: { reason },
        });
        return FAIL;
      }
      const at = v.lastIndexOf("@");
      return `${v.slice(0, at)}@${v.slice(at + 1).toLowerCase()}`;
    },
  };
}

/** Literal["a", "b"]: pydantic quotes each value and joins the last with "or". */
export function literal<const V extends string>(...values: V[]): Type<V> {
  const quoted = values.map((x) => `'${x}'`);
  const expected =
    quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}` : (quoted[0] ?? "");
  return {
    parse(v, loc, issues) {
      if (typeof v === "string" && (values as string[]).includes(v)) return v as V;
      issues.push(issue("literal_error", loc, `Input should be ${expected}`, v, { expected }));
      return FAIL;
    },
  };
}

export function list<T>(item: Type<T>, opts: { min?: number; max?: number } = {}): Type<T[]> {
  return {
    parse(v, loc, issues) {
      if (!Array.isArray(v)) {
        issues.push(issue("list_type", loc, "Input should be a valid list", v));
        return FAIL;
      }
      // Field(min_length/max_length=N) on a list: pydantic checks the length before the items.
      if (opts.min !== undefined && v.length < opts.min) {
        issues.push(
          issue(
            "too_short",
            loc,
            `List should have at least ${opts.min} item${opts.min === 1 ? "" : "s"} after validation, not ${v.length}`,
            v,
            { field_type: "List", min_length: opts.min, actual_length: v.length },
          ),
        );
        return FAIL;
      }
      if (opts.max !== undefined && v.length > opts.max) {
        issues.push(
          issue(
            "too_long",
            loc,
            `List should have at most ${opts.max} item${opts.max === 1 ? "" : "s"} after validation, not ${v.length}`,
            v,
            { field_type: "List", max_length: opts.max, actual_length: v.length },
          ),
        );
        return FAIL;
      }
      const out: T[] = [];
      let failed = false;
      v.forEach((x, i) => {
        const r = item.parse(x, [...loc, i], issues);
        if (r === FAIL) failed = true;
        else out.push(r);
      });
      return failed ? FAIL : out;
    },
  };
}

export function dict(): Type<Record<string, unknown>> {
  return {
    parse(v, loc, issues) {
      if (!isObject(v)) {
        issues.push(issue("dict_type", loc, "Input should be a valid dictionary", v));
        return FAIL;
      }
      return v;
    },
  };
}

export function any(): Type<unknown> {
  return { parse: (v) => v };
}

/** Optional[X]: null passes through, anything else must be an X. */
export function nullable<T>(inner: Type<T>): Type<T | null> {
  return { parse: (v, loc, issues) => (v === null ? null : inner.parse(v, loc, issues)) };
}

export interface FieldSpec<T> {
  readonly type: Type<T>;
  readonly required: boolean;
  readonly fallback?: () => T;
}

export function required<T>(type: Type<T>): FieldSpec<T> {
  return { type, required: true };
}

export function optional<T>(type: Type<T>, fallback: T): FieldSpec<T> {
  return { type, required: false, fallback: () => fallback };
}

type Shape = Record<string, FieldSpec<unknown>>;
export type Infer<S extends Shape> = {
  [K in keyof S]: S[K] extends FieldSpec<infer T> ? T : never;
};

export interface Parsed<T> {
  readonly data: T;
  /** Fields the client actually sent, pydantic's model_fields_set. */
  readonly fieldsSet: ReadonlySet<string>;
}

export interface Model<S extends Shape> extends Type<Parsed<Infer<S>>> {
  readonly shape: S;
}

/** A pydantic BaseModel: unknown keys are ignored, missing required keys report the whole input. */
export function model<S extends Shape>(shape: S): Model<S> {
  return {
    shape,
    parse(v, loc, issues) {
      if (!isObject(v)) {
        issues.push(
          issue(
            "model_attributes_type",
            loc,
            "Input should be a valid dictionary or object to extract fields from",
            v,
          ),
        );
        return FAIL;
      }
      const data: Record<string, unknown> = {};
      const set = new Set<string>();
      let failed = false;
      for (const [key, spec] of Object.entries(shape)) {
        if (!(key in v)) {
          if (spec.required) {
            issues.push(issue("missing", [...loc, key], "Field required", v));
            failed = true;
          } else data[key] = spec.fallback?.();
          continue;
        }
        set.add(key);
        const r = spec.type.parse(v[key], [...loc, key], issues);
        if (r === FAIL) failed = true;
        else data[key] = r;
      }
      return failed ? FAIL : { data: data as Infer<S>, fieldsSet: set };
    },
  };
}

/** Unwraps a model inside a list or another model. */
export function nested<S extends Shape>(m: Model<S>): Type<Infer<S>> {
  return {
    parse(v, loc, issues) {
      const r = m.parse(v, loc, issues);
      return r === FAIL ? FAIL : r.data;
    },
  };
}

function fail(issues: Issue[]): never {
  // The body is the bare list, as FastAPI sends it.
  throw new ValidationError(
    "Request validation failed",
    issues as unknown as Record<string, unknown>,
  );
}

function collectParams<S extends Shape>(
  where: "query" | "path",
  values: Record<string, string | undefined>,
  shape: S,
  issues: Issue[],
): Infer<S> {
  const data: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(shape)) {
    const v = values[key];
    if (v === undefined) {
      if (spec.required) issues.push(issue("missing", [where, key], "Field required", null));
      else data[key] = spec.fallback?.();
      continue;
    }
    const r = spec.type.parse(v, [where, key], issues);
    if (r !== FAIL) data[key] = r;
  }
  return data as Infer<S>;
}

async function collectBody<T>(
  req: { text(): Promise<string> },
  type: Type<T>,
  issues: Issue[],
): Promise<T | undefined> {
  const text = await req.text();
  if (text.trim() === "") {
    issues.push(issue("missing", ["body"], "Field required", null));
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // FastAPI reports the decoder's position and message; nothing reads them, so only the shape is kept.
    issues.push({
      type: "json_invalid",
      loc: ["body", 0],
      msg: "JSON decode error",
      input: {},
      ctx: { error: "Invalid JSON" },
    });
    return undefined;
  }
  const out = type.parse(raw, ["body"], issues);
  return out === FAIL ? undefined : out;
}

type Spec = {
  path?: Shape;
  query?: Shape;
  body?: Type<unknown>;
};

type Result<S extends Spec> = {
  path: S["path"] extends Shape ? Infer<S["path"]> : undefined;
  query: S["query"] extends Shape ? Infer<S["query"]> : undefined;
  body: S["body"] extends Type<infer T> ? T : undefined;
};

/**
 * Validates a whole request the way FastAPI does: path and query errors first, then the
 * body, reported together as one 422. An absent body is one "missing" error at ["body"].
 */
export async function validate<S extends Spec>(
  req: {
    param(): Record<string, string>;
    query(): Record<string, string>;
    text(): Promise<string>;
  },
  spec: S,
): Promise<Result<S>> {
  const issues: Issue[] = [];
  const path = spec.path ? collectParams("path", req.param(), spec.path, issues) : undefined;
  const query = spec.query ? collectParams("query", req.query(), spec.query, issues) : undefined;
  const body = spec.body ? await collectBody(req, spec.body, issues) : undefined;
  if (issues.length) fail(issues);
  return { path, query, body } as Result<S>;
}
