import { PyFloat } from "./hashing";

/**
 * A small schema language for analysis payloads that validates and normalises exactly
 * like the pydantic models it replaces (lax mode, extra keys forbidden, strings stripped):
 * the same accepted values, the same error texts in the same order, and a normalised
 * dump without None fields. Error texts reach hosts through 422 details, and normalised
 * payloads feed content hashes shared with the Python stack.
 */

export type Schema =
  | { readonly kind: "str"; readonly min?: number; readonly max?: number }
  | { readonly kind: "literal"; readonly values: readonly (string | boolean)[] }
  | { readonly kind: "float"; readonly ge?: number; readonly le?: number; readonly gt?: number }
  | { readonly kind: "int"; readonly ge?: number; readonly le?: number }
  | { readonly kind: "bool" }
  | { readonly kind: "list"; readonly item: Schema; readonly maxItems?: number }
  | { readonly kind: "dict"; readonly value?: Schema }
  | { readonly kind: "any" }
  | { readonly kind: "optional"; readonly inner: Schema }
  | { readonly kind: "model"; readonly model: Model };

export interface ModelField {
  readonly name: string;
  readonly schema: Schema;
  /** Absent means required. A function builds a fresh default (pydantic default_factory). */
  readonly default?: unknown | (() => unknown);
}

export interface Model {
  readonly name: string;
  readonly fields: readonly ModelField[];
  /** Payload models strip whitespace from every string (pydantic str_strip_whitespace). */
  readonly strip?: boolean;
  /** false lets unknown keys through silently (pydantic's default "ignore"). */
  readonly forbidExtra?: boolean;
}

export interface SchemaError {
  readonly loc: readonly (string | number)[];
  readonly msg: string;
  readonly type: string;
}

const FAIL = Symbol("fail");
type Out = unknown | typeof FAIL;

const isDict = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof PyFloat);

function literalText(values: readonly (string | boolean)[]): string {
  const q = values.map((v) => (typeof v === "string" ? `'${v}'` : v ? "True" : "False"));
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} or ${q.at(-1)}` : (q[0] ?? "");
}

function num(v: unknown): number | null {
  if (v instanceof PyFloat) return v.value;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

function validateValue(
  schema: Schema,
  v: unknown,
  loc: (string | number)[],
  errors: SchemaError[],
  strip: boolean,
): Out {
  switch (schema.kind) {
    case "any":
      return v;
    case "optional":
      return v === null ? null : validateValue(schema.inner, v, loc, errors, strip);
    case "str": {
      if (typeof v !== "string") {
        errors.push({ loc, msg: "Input should be a valid string", type: "string_type" });
        return FAIL;
      }
      const s = strip ? v.trim() : v;
      const len = [...s].length;
      if (schema.min !== undefined && len < schema.min) {
        errors.push({
          loc,
          msg: `String should have at least ${schema.min} character${schema.min === 1 ? "" : "s"}`,
          type: "string_too_short",
        });
        return FAIL;
      }
      if (schema.max !== undefined && len > schema.max) {
        errors.push({
          loc,
          msg: `String should have at most ${schema.max} character${schema.max === 1 ? "" : "s"}`,
          type: "string_too_long",
        });
        return FAIL;
      }
      return s;
    }
    case "literal": {
      if (schema.values.includes(v as string | boolean)) return v;
      errors.push({
        loc,
        msg: `Input should be ${literalText(schema.values)}`,
        type: "literal_error",
      });
      return FAIL;
    }
    case "bool": {
      if (typeof v === "boolean") return v;
      if (v === 0 || v === 1) return v === 1;
      if (typeof v === "string") {
        const t = v.trim().toLowerCase();
        if (["1", "on", "t", "true", "y", "yes"].includes(t)) return true;
        if (["0", "off", "f", "false", "n", "no"].includes(t)) return false;
      }
      errors.push({ loc, msg: "Input should be a valid boolean", type: "bool_type" });
      return FAIL;
    }
    case "float": {
      let n = num(v);
      if (n === null && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v.trim())))
        n = Number(v.trim());
      if (n === null) {
        errors.push({
          loc,
          msg:
            typeof v === "string"
              ? "Input should be a valid number, unable to parse string as a number"
              : "Input should be a valid number",
          type: typeof v === "string" ? "float_parsing" : "float_type",
        });
        return FAIL;
      }
      if (schema.gt !== undefined && !(n > schema.gt)) {
        errors.push({
          loc,
          msg: `Input should be greater than ${schema.gt}`,
          type: "greater_than",
        });
        return FAIL;
      }
      if (schema.ge !== undefined && n < schema.ge) {
        errors.push({
          loc,
          msg: `Input should be greater than or equal to ${schema.ge}`,
          type: "greater_than_equal",
        });
        return FAIL;
      }
      if (schema.le !== undefined && n > schema.le) {
        errors.push({
          loc,
          msg: `Input should be less than or equal to ${schema.le}`,
          type: "less_than_equal",
        });
        return FAIL;
      }
      return new PyFloat(n);
    }
    case "int": {
      let n: number | null = null;
      if (typeof v === "boolean") n = v ? 1 : 0;
      else if (v instanceof PyFloat || typeof v === "number") {
        const x = v instanceof PyFloat ? v.value : v;
        if (!Number.isInteger(x)) {
          errors.push({
            loc,
            msg: "Input should be a valid integer, got a number with a fractional part",
            type: "int_from_float",
          });
          return FAIL;
        }
        n = x;
      } else if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) n = Number(v.trim());
      if (n === null) {
        errors.push({
          loc,
          msg:
            typeof v === "string"
              ? "Input should be a valid integer, unable to parse string as an integer"
              : "Input should be a valid integer",
          type: typeof v === "string" ? "int_parsing" : "int_type",
        });
        return FAIL;
      }
      if (schema.ge !== undefined && n < schema.ge) {
        errors.push({
          loc,
          msg: `Input should be greater than or equal to ${schema.ge}`,
          type: "greater_than_equal",
        });
        return FAIL;
      }
      if (schema.le !== undefined && n > schema.le) {
        errors.push({
          loc,
          msg: `Input should be less than or equal to ${schema.le}`,
          type: "less_than_equal",
        });
        return FAIL;
      }
      return n;
    }
    case "list": {
      if (!Array.isArray(v)) {
        errors.push({ loc, msg: "Input should be a valid list", type: "list_type" });
        return FAIL;
      }
      if (schema.maxItems !== undefined && v.length > schema.maxItems) {
        errors.push({
          loc,
          msg: `List should have at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"} after validation, not ${v.length}`,
          type: "too_long",
        });
        return FAIL;
      }
      const out: unknown[] = [];
      let failed = false;
      v.forEach((item, i) => {
        const r = validateValue(schema.item, item, [...loc, i], errors, strip);
        if (r === FAIL) failed = true;
        else out.push(r);
      });
      return failed ? FAIL : out;
    }
    case "dict": {
      if (!isDict(v)) {
        errors.push({ loc, msg: "Input should be a valid dictionary", type: "dict_type" });
        return FAIL;
      }
      if (!schema.value) return { ...v };
      const out: Record<string, unknown> = {};
      let failed = false;
      for (const [k, item] of Object.entries(v)) {
        const r = validateValue(schema.value, item, [...loc, k], errors, strip);
        if (r === FAIL) failed = true;
        else out[k] = r;
      }
      return failed ? FAIL : out;
    }
    case "model":
      return validateModel(schema.model, v, loc, errors);
  }
}

function validateModel(
  model: Model,
  v: unknown,
  loc: (string | number)[],
  errors: SchemaError[],
): Out {
  if (!isDict(v)) {
    errors.push({
      loc,
      msg: `Input should be a valid dictionary or instance of ${model.name}`,
      type: "model_type",
    });
    return FAIL;
  }
  const strip = model.strip ?? false;
  const out: Record<string, unknown> = {};
  let failed = false;
  for (const field of model.fields) {
    if (!(field.name in v) || v[field.name] === undefined) {
      if (!("default" in field)) {
        errors.push({ loc: [...loc, field.name], msg: "Field required", type: "missing" });
        failed = true;
      } else {
        out[field.name] = typeof field.default === "function" ? field.default() : field.default;
      }
      continue;
    }
    const r = validateValue(field.schema, v[field.name], [...loc, field.name], errors, strip);
    if (r === FAIL) failed = true;
    else out[field.name] = r;
  }
  if (model.forbidExtra !== false) {
    const known = new Set(model.fields.map((f) => f.name));
    for (const key of Object.keys(v)) {
      if (!known.has(key)) {
        errors.push({
          loc: [...loc, key],
          msg: "Extra inputs are not permitted",
          type: "extra_forbidden",
        });
        failed = true;
      }
    }
  }
  return failed ? FAIL : out;
}

/** model_dump(mode="json", exclude_none=True): None fields of models vanish, dict values stay. */
function dump(schema: Schema, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  switch (schema.kind) {
    case "optional":
      return dump(schema.inner, v);
    case "list":
      return (v as unknown[]).map((x) => dump(schema.item, x));
    case "dict":
      return schema.value
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([k, x]) => [
              k,
              dump(schema.value as Schema, x),
            ]),
          )
        : v;
    case "model": {
      const out: Record<string, unknown> = {};
      for (const f of schema.model.fields) {
        const x = (v as Record<string, unknown>)[f.name];
        if (x === null || x === undefined) continue;
        out[f.name] = dump(f.schema, x);
      }
      return out;
    }
    default:
      return v;
  }
}

export type Validated =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly errors: readonly SchemaError[] };

/** Validates and returns the normalised dump, or pydantic's error list. */
export function validateAgainst(model: Model, value: unknown, excludeNone = true): Validated {
  const errors: SchemaError[] = [];
  const r = validateModel(model, value, [], errors);
  if (r === FAIL) return { ok: false, errors };
  const schema: Schema = { kind: "model", model };
  return {
    ok: true,
    value: (excludeNone ? dump(schema, r) : r) as Record<string, unknown>,
  };
}

/** "loc.path: message" joined the way the Python errors summarised the first five. */
export function describeErrors(errors: readonly SchemaError[]): string {
  return errors
    .slice(0, 5)
    .map((e) => `${e.loc.map(String).join(".") || "(root)"}: ${e.msg}`)
    .join("; ");
}

// Builders keep the model definitions close to the pydantic classes they mirror.
export const s = {
  str: (o: { min?: number; max?: number } = {}): Schema => ({ kind: "str", ...o }),
  lit: (...values: (string | boolean)[]): Schema => ({ kind: "literal", values }),
  float: (o: { ge?: number; le?: number; gt?: number } = {}): Schema => ({ kind: "float", ...o }),
  int: (o: { ge?: number; le?: number } = {}): Schema => ({ kind: "int", ...o }),
  bool: (): Schema => ({ kind: "bool" }),
  list: (item: Schema, maxItems?: number): Schema => ({
    kind: "list",
    item,
    ...(maxItems !== undefined && { maxItems }),
  }),
  dict: (value?: Schema): Schema => ({ kind: "dict", ...(value && { value }) }),
  any: (): Schema => ({ kind: "any" }),
  opt: (inner: Schema): Schema => ({ kind: "optional", inner }),
  model: (model: Model): Schema => ({ kind: "model", model }),
};

export const required = (name: string, schema: Schema): ModelField => ({ name, schema });
export const withDefault = (name: string, schema: Schema, d: unknown): ModelField => ({
  name,
  schema,
  default: d,
});
