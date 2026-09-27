import { ValidationError } from "@echo/core";

/**
 * Request validation that answers exactly like FastAPI with pydantic 2.12 (422 with a
 * `detail` list of `{type, loc, msg, input, ctx?, url}`), because the dashboard shows
 * these messages. Only the constraint kinds the old routes declare are modelled. Once
 * the frontend reads the unified error contract this becomes plain zod.
 */
export interface PydanticError {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
  url?: string;
}

const URL_BASE = "https://errors.pydantic.dev/2.12/v/";

function err(
  type: string,
  loc: (string | number)[],
  msg: string,
  input: unknown,
  ctx?: Record<string, unknown>,
): PydanticError {
  return { type, loc, msg, input, ...(ctx && { ctx }), url: URL_BASE + type };
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: PydanticError[] };
type Where = "body" | "query";

export interface Field<T> {
  /** Parses a present value; `where` decides lax string coercion (query values are strings). */
  parse(input: unknown, loc: (string | number)[], where: Where): Result<T>;
  readonly required: boolean;
  readonly fallback?: () => T;
}

function field<T>(
  parse: Field<T>["parse"],
  required: boolean,
  fallback?: () => T,
): Field<T> & {
  optional(): Field<T | null>;
  default(v: T): Field<T>;
} {
  const f: Field<T> = { parse, required, ...(fallback && { fallback }) };
  return {
    ...f,
    optional: () => ({
      parse: (v, loc, where) => (v === null ? { ok: true, value: null } : parse(v, loc, where)),
      required: false,
      fallback: () => null,
    }),
    default: (d: T) => ({ parse, required: false, fallback: () => d }),
  };
}

export const v = {
  str(opts: { min?: number; max?: number } = {}) {
    return field<string>((input, loc) => {
      if (typeof input !== "string")
        return {
          ok: false,
          errors: [err("string_type", loc, "Input should be a valid string", input)],
        };
      const len = [...input].length;
      if (opts.min !== undefined && len < opts.min)
        return {
          ok: false,
          errors: [
            err(
              "string_too_short",
              loc,
              `String should have at least ${opts.min} character${opts.min === 1 ? "" : "s"}`,
              input,
              { min_length: opts.min },
            ),
          ],
        };
      if (opts.max !== undefined && len > opts.max)
        return {
          ok: false,
          errors: [
            err(
              "string_too_long",
              loc,
              `String should have at most ${opts.max} character${opts.max === 1 ? "" : "s"}`,
              input,
              { max_length: opts.max },
            ),
          ],
        };
      return { ok: true, value: input };
    }, true);
  },

  literal<const L extends string>(options: readonly L[]) {
    const expected =
      options.length === 1
        ? `'${options[0]}'`
        : `${options
            .slice(0, -1)
            .map((o) => `'${o}'`)
            .join(", ")} or '${options.at(-1)}'`;
    return field<L>((input, loc) => {
      if (typeof input === "string" && (options as readonly string[]).includes(input))
        return { ok: true, value: input as L };
      return {
        ok: false,
        errors: [err("literal_error", loc, `Input should be ${expected}`, input, { expected })],
      };
    }, true);
  },

  int(opts: { ge?: number; le?: number } = {}) {
    return field<number>((input, loc, where) => {
      let n: number;
      if (typeof input === "number" && Number.isFinite(input)) {
        if (!Number.isInteger(input))
          return {
            ok: false,
            errors: [
              err(
                "int_from_float",
                loc,
                "Input should be a valid integer, got a number with a fractional part",
                input,
              ),
            ],
          };
        n = input;
      } else if (typeof input === "boolean" && where === "body") {
        n = input ? 1 : 0;
      } else if (typeof input === "string") {
        const t = input.trim();
        if (!/^[+-]?\d+$/.test(t))
          return {
            ok: false,
            errors: [
              err(
                "int_parsing",
                loc,
                "Input should be a valid integer, unable to parse string as an integer",
                input,
              ),
            ],
          };
        n = Number(t);
      } else {
        return {
          ok: false,
          errors: [err("int_type", loc, "Input should be a valid integer", input)],
        };
      }
      if (opts.ge !== undefined && n < opts.ge)
        return {
          ok: false,
          errors: [
            err(
              "greater_than_equal",
              loc,
              `Input should be greater than or equal to ${opts.ge}`,
              input,
              { ge: opts.ge },
            ),
          ],
        };
      if (opts.le !== undefined && n > opts.le)
        return {
          ok: false,
          errors: [
            err("less_than_equal", loc, `Input should be less than or equal to ${opts.le}`, input, {
              le: opts.le,
            }),
          ],
        };
      return { ok: true, value: n };
    }, true);
  },

  num(opts: { gt?: number } = {}) {
    return field<number>((input, loc) => {
      let n: number;
      if (typeof input === "number" && Number.isFinite(input)) n = input;
      else if (typeof input === "boolean") n = input ? 1 : 0;
      else if (typeof input === "string") {
        const t = input.trim();
        n = t === "" ? Number.NaN : Number(t);
        if (Number.isNaN(n))
          return {
            ok: false,
            errors: [
              err(
                "float_parsing",
                loc,
                "Input should be a valid number, unable to parse string as a number",
                input,
              ),
            ],
          };
      } else
        return {
          ok: false,
          errors: [err("float_type", loc, "Input should be a valid number", input)],
        };
      if (opts.gt !== undefined && !(n > opts.gt))
        return {
          ok: false,
          errors: [
            err("greater_than", loc, `Input should be greater than ${opts.gt}`, input, {
              gt: opts.gt,
            }),
          ],
        };
      return { ok: true, value: n };
    }, true);
  },

  bool() {
    return field<boolean>((input, loc) => {
      if (typeof input === "boolean") return { ok: true, value: input };
      if (input === 0 || input === 1) return { ok: true, value: input === 1 };
      if (typeof input === "string") {
        const t = input.trim().toLowerCase();
        if (["1", "on", "t", "true", "y", "yes"].includes(t)) return { ok: true, value: true };
        if (["0", "off", "f", "false", "n", "no"].includes(t)) return { ok: true, value: false };
        return {
          ok: false,
          errors: [
            err(
              "bool_parsing",
              loc,
              "Input should be a valid boolean, unable to interpret input",
              input,
            ),
          ],
        };
      }
      return {
        ok: false,
        errors: [err("bool_type", loc, "Input should be a valid boolean", input)],
      };
    }, true);
  },

  /** A list of strings, as pydantic `list[str]`. */
  strList() {
    return field<string[]>((input, loc) => {
      if (!Array.isArray(input))
        return {
          ok: false,
          errors: [err("list_type", loc, "Input should be a valid list", input)],
        };
      const errors: PydanticError[] = [];
      input.forEach((x, i) => {
        if (typeof x !== "string")
          errors.push(err("string_type", [...loc, i], "Input should be a valid string", x));
      });
      return errors.length ? { ok: false, errors } : { ok: true, value: input as string[] };
    }, true);
  },

  /** Any JSON value, as pydantic `Any` / `dict`. */
  any() {
    return field<unknown>((input) => ({ ok: true, value: input }), true);
  },
};

type Shape = Record<string, Field<unknown>>;
export type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Field<infer T> ? T : never };

function parseObject<S extends Shape>(
  shape: S,
  obj: Record<string, unknown>,
  where: Where,
  errors: PydanticError[],
  wholeInput: unknown,
): { value: Infer<S>; set: Set<string> } {
  const out: Record<string, unknown> = {};
  const set = new Set<string>();
  for (const [name, f] of Object.entries(shape)) {
    const loc = [where, name];
    if (!(name in obj) || obj[name] === undefined) {
      if (f.required)
        errors.push(err("missing", loc, "Field required", where === "body" ? wholeInput : null));
      else out[name] = f.fallback?.();
      continue;
    }
    set.add(name);
    const r = f.parse(obj[name], loc, where);
    if (r.ok) out[name] = r.value;
    else errors.push(...r.errors);
  }
  return { value: out as Infer<S>, set };
}

/** Raw request parts the validators read; routes build it once per request. */
export interface RawRequest {
  readonly query: Record<string, string>;
  /** The raw body text, or null when the request carried none. */
  readonly body: string | null;
}

export async function rawRequest(req: {
  query(): Record<string, string>;
  text(): Promise<string>;
}): Promise<RawRequest> {
  const text = await req.text();
  return { query: req.query(), body: text.length ? text : null };
}

/**
 * Validates query parameters and a JSON body together and throws one 422 listing every
 * problem, query first, the order FastAPI reports them in. `body: null` means the route
 * takes no body; a declared body is required, even when every field is optional.
 */
export function validate<Q extends Shape, B extends Shape>(
  raw: RawRequest,
  spec: { query?: Q; body?: B },
): { query: Infer<Q>; body: Infer<B>; bodySet: ReadonlySet<string> } {
  const errors: PydanticError[] = [];
  const query = spec.query
    ? parseObject(spec.query, raw.query, "query", errors, null).value
    : ({} as Infer<Q>);
  let body = {} as Infer<B>;
  let bodySet = new Set<string>();
  if (spec.body) {
    if (raw.body === null) {
      errors.push(err("missing", ["body"], "Field required", null));
    } else {
      let parsed: unknown;
      let ok = true;
      try {
        parsed = JSON.parse(raw.body);
      } catch {
        ok = false;
        errors.push({
          type: "json_invalid",
          loc: ["body", 0],
          msg: "JSON decode error",
          input: {},
          ctx: { error: "Expecting value" },
        });
      }
      if (ok) {
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          errors.push(
            err(
              "model_attributes_type",
              ["body"],
              "Input should be a valid dictionary or object to extract fields from",
              parsed,
            ),
          );
        } else {
          const r = parseObject(
            spec.body,
            parsed as Record<string, unknown>,
            "body",
            errors,
            parsed,
          );
          body = r.value;
          bodySet = r.set;
        }
      }
    }
  }
  // The error handler sends `details` as the body's `detail`, so the list goes there as is.
  if (errors.length)
    throw new ValidationError(
      "Request validation failed",
      errors as unknown as Record<string, unknown>,
    );
  return { query, body, bodySet };
}
