import { staffKeyClaims } from "@dembrane/accounts";
import type { MiddlewareHandler } from "hono";
import type { Deps, Env, Signed } from "../deps";

/**
 * Reads the session (cookie or bearer token) once per request and exposes the principal.
 * It never rejects: routes that need a user call requireUser from @dembrane/http.
 * A staff API key is held to its hard expiry and acts with its scope only: it is never
 * the blanket staff flag, so it reaches no customer data through staff bypasses.
 */
export function session(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    let principal: Signed | null = null;
    const found = await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    if (found?.user) principal = await deps.principalFor(found.user.id);
    const key = found
      ? staffKeyClaims(found.session.userAgent, new Date(found.session.createdAt))
      : null;
    if (principal && key)
      principal =
        key.until.getTime() > Date.now()
          ? { ...principal, isStaff: false, staffPolicies: key.scope }
          : null;
    c.set("principal", principal);
    await next();
  };
}
