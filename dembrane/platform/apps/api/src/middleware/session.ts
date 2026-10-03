import { staffKeyClaims } from "@dembrane/accounts";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
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
    // A held session is a sign-in still waiting for the person to replace their sessions on
    // other browsers (auth/overlap.ts): until then it is nobody.
    if (found?.user && found.session.held !== true) {
      principal = await deps.principalFor(found.user.id);
      touch(deps, found.session);
    }
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

const SEEN_EVERY_MS = 5 * 60_000;

/**
 * Keeps auth_session.last_seen_at within a few minutes of the session's last request, so a
 * later sign-in elsewhere can tell a browser in use from one left signed in. Not awaited.
 */
function touch(deps: Deps, session: { id: string; lastSeenAt?: Date | null | undefined }): void {
  const seen = session.lastSeenAt?.getTime() ?? 0;
  if (Date.now() - seen < SEEN_EVERY_MS) return;
  void deps.db
    .update(schema.auth_session)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.auth_session.id, session.id))
    .catch((err: unknown) => deps.logger.warn({ err }, "session last seen not saved"));
}
