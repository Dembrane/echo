import { BadRequestError, ValidationError } from "@dembrane/core";
import type { Ctx } from "@dembrane/http";
import type { z } from "zod";

/**
 * Parses a JSON body against a zod schema. Failures answer 422 with the same list shape
 * the rest of the API uses (`type`, `loc`, `msg`, `input`), so the frontend shows them
 * the same way.
 */
export async function body<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse((await c.req.text()) || "{}");
  } catch {
    throw new BadRequestError("Body is not valid JSON");
  }
  return parse(schema, raw);
}

export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new ValidationError(
    "Invalid request",
    r.error.issues.map((i) => ({
      type: i.code,
      loc: ["body", ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))],
      msg: i.message,
      input: undefined,
    })),
  );
}
