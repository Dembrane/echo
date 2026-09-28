import type { Principal } from "@dembrane/access";
import { UnauthenticatedError } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import type { Context } from "hono";

/** A signed-in caller as routes see it. */
export interface Signed extends Principal {
  readonly isStaff: boolean;
}

/** Per-request values every route can read; set by the API's middleware. */
export type Env = {
  Variables: { requestId: string; logger: Logger; principal: Signed | null };
};

export type Ctx = Context<Env>;

/** The signed-in caller, or 401 with the body the old API sends. */
export function requireUser(c: Ctx): Signed {
  const p = c.get("principal");
  if (!p) throw new UnauthenticatedError("Invalid session");
  return p;
}

export * as v from "./validate";

/**
 * A timestamp as Directus serialised it ("2026-09-01T09:00:00.000Z"). Postgres hands back
 * "2026-09-01 09:00:00+00", which some browsers do not parse; responses keep the old form.
 */
export function directusTime(v: string | null | undefined): string | null {
  return v ? new Date(v).toISOString() : null;
}
