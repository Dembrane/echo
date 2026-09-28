import { BadRequestError, type FieldErrorCode, ValidationError } from "@dembrane/core";
import type { Ctx, v } from "@dembrane/http";
import type { z } from "zod";

/**
 * Parses a JSON body against a zod schema. Failures answer 422 with the same list shape
 * the rest of the API uses (`type`, `loc`, `msg`, `input`), so the frontend shows them
 * the same way, and the same field codes in params.fields.
 */
export async function body<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse((await c.req.text()) || "{}");
  } catch {
    throw new BadRequestError("request.invalid_json");
  }
  return parse(schema, raw);
}

type Issue = z.core.$ZodIssue;

/** The field code for a zod issue; the frontend keys its inline message on it. */
export function zodFieldCode(i: Issue): FieldErrorCode {
  switch (i.code) {
    case "invalid_type":
      return i.input === undefined ? "field.required" : "field.invalid_type";
    case "too_small":
      if (i.origin === "string") return "field.too_short";
      if (i.origin === "array" || i.origin === "set") return "field.too_few_items";
      return "field.too_small";
    case "too_big":
      return i.origin === "string" ? "field.too_long" : "field.too_large";
    case "invalid_format":
      if (i.format === "email") return "field.invalid_email";
      if (i.format === "url") return "field.invalid_url";
      if (i.format === "date" || i.format === "datetime") return "field.invalid_date";
      return "field.invalid";
    case "invalid_value":
      return "field.invalid_choice";
    default:
      return "field.invalid";
  }
}

function zodFieldParams(i: Issue): Record<string, string | number> {
  if (i.code === "too_small") {
    const min = Number(i.minimum);
    return i.origin === "string" || i.origin === "array" || i.origin === "set"
      ? { min_length: min }
      : { min };
  }
  if (i.code === "too_big") {
    const max = Number(i.maximum);
    return i.origin === "string" ? { max_length: max } : { max };
  }
  if (i.code === "invalid_value")
    return { expected: i.values.map((x) => `'${String(x)}'`).join(", ") };
  return {};
}

export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const path = (i: Issue) => i.path.map((p) => (typeof p === "symbol" ? String(p) : p));
  const issues = r.error.issues.map((i) => ({
    type: i.code,
    loc: ["body", ...path(i)],
    msg: i.message,
    input: undefined,
  }));
  const fields: v.FieldProblem[] = r.error.issues.map((i) => ({
    field: path(i).join("."),
    loc: ["body", ...path(i)],
    code: zodFieldCode(i),
    params: zodFieldParams(i),
  }));
  throw new ValidationError("validation.invalid_input", {
    message: "Invalid request",
    details: issues,
    params: { fields },
  });
}
