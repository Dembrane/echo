import { ValidationError } from "@dembrane/core";
import { v } from "@dembrane/http";
import type { z } from "zod";

/**
 * A create request's object field (`overrides`, `digest`) that its zod schema refused, as
 * the 422 every route answers: one issue per problem, located under `body.<field>`, the
 * way the Python API named them (an unknown key is `extra_forbidden`).
 */
export function invalidBodyField(field: string, raw: unknown, error: z.ZodError): ValidationError {
  const issues: v.Issue[] = error.issues.flatMap((i) =>
    i.code === "unrecognized_keys"
      ? i.keys.map((k) => ({
          type: "extra_forbidden",
          loc: ["body", field, k],
          msg: "Extra inputs are not permitted",
          input: (raw as Record<string, unknown>)[k],
        }))
      : [
          {
            type: i.path.length ? "value_error" : "dict_type",
            loc: ["body", field, ...i.path.map(String)],
            msg: i.message,
            input: i.path.length ? (raw as Record<string, unknown>)[String(i.path[0])] : raw,
          },
        ],
  );
  return new ValidationError("validation.invalid_input", {
    details: issues,
    params: { fields: v.fieldProblems(issues) },
  });
}
