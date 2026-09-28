import { PlatformError } from "@echo/core";
import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../deps";

/**
 * The one place errors become responses. Bodies keep FastAPI's `{ detail }` shape so the
 * dashboard, portal and iOS app read them unchanged; the unified contract replaces it.
 */
export const onError: ErrorHandler<Env> = (err, c) => {
  if (err instanceof PlatformError) {
    return c.json({ detail: err.details ?? err.message }, err.status as 400, err.headers);
  }
  if (err instanceof HTTPException) {
    return c.json({ detail: err.message }, err.status);
  }
  c.get("logger")?.error({ err }, "unhandled error");
  return c.json({ detail: "Internal Server Error" }, 500);
};

export const notFound: NotFoundHandler<Env> = (c) => c.json({ detail: "Not Found" }, 404);
