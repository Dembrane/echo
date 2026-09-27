import { PlatformError } from "@echo/core";
import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../deps";

/** The one place errors become responses: `{ error: { code, message, details? } }`. */
export const onError: ErrorHandler<Env> = (err, c) => {
  if (err instanceof PlatformError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details && { details: err.details }),
        },
      },
      err.status as 400,
    );
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: "http_error", message: err.message } }, err.status);
  }
  c.get("logger")?.error({ err }, "unhandled error");
  return c.json(
    {
      error: { code: "internal", message: "Something went wrong", request_id: c.get("requestId") },
    },
    500,
  );
};

export const notFound: NotFoundHandler<Env> = (c) =>
  c.json(
    { error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } },
    404,
  );
