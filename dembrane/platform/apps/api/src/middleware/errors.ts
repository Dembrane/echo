import { bodyFor, type ErrorCode, errorBody, PlatformError } from "@dembrane/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../deps";

/** The code for an HTTPException hono raised itself (a body limit, a malformed request). */
function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "auth.session_expired";
  if (status === 403) return "access.forbidden";
  if (status === 404) return "request.route_not_found";
  if (status === 413) return "request.too_large";
  if (status === 429) return "rate_limit.exceeded";
  if (status >= 400 && status < 500) return "request.invalid";
  if (status === 503) return "internal.unavailable";
  return "internal.unexpected";
}

/**
 * Every error response is logged once with its code, so sam and alerting count codes, not
 * texts. 5xx at error level (someone should look), 4xx at info (the caller's problem).
 */
function logCode(
  c: Context<Env>,
  status: number,
  code: ErrorCode,
  extra: Record<string, unknown> = {},
) {
  const log = c.get("logger");
  if (!log) return;
  const fields = { code, status, method: c.req.method, route: c.req.routePath, ...extra };
  if (status >= 500) log.error(fields, "request failed");
  else log.info(fields, "request refused");
}

/**
 * The one place errors become responses. Bodies keep FastAPI's `{ detail }` for the
 * dashboard, portal and iOS app, and add `code`, `params` and `action`, which clients key
 * their messages and buttons on.
 */
export const onError: ErrorHandler<Env> = (err, c) => {
  if (err instanceof PlatformError) {
    logCode(c, err.status, err.code, { params: err.params });
    return c.json(errorBody(err), err.status as 400, err.headers);
  }
  if (err instanceof HTTPException) {
    const code = codeForStatus(err.status);
    logCode(c, err.status, code);
    return c.json(bodyFor(code, err.message), err.status);
  }
  logCode(c, 500, "internal.unexpected", { err });
  return c.json(bodyFor("internal.unexpected"), 500);
};

export const notFound: NotFoundHandler<Env> = (c) => {
  logCode(c, 404, "request.route_not_found");
  return c.json(bodyFor("request.route_not_found"), 404);
};
