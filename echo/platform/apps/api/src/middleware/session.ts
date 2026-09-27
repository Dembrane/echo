import { UnauthenticatedError } from "@echo/core";
import type { Context, MiddlewareHandler } from "hono";
import type { Deps, Env, Signed } from "../deps";

/**
 * Reads the session (cookie or bearer token) once per request and exposes the principal.
 * It never rejects: routes that need a user call requireUser, public routes do not.
 */
export function session(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    let principal: Signed | null = null;
    const found = await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    if (found?.user) principal = await deps.principalFor(found.user.id);
    c.set("principal", principal);
    await next();
  };
}

export function requireUser(c: Context<Env>): Signed {
  const p = c.get("principal");
  if (!p) throw new UnauthenticatedError("Sign in to continue");
  return p;
}
