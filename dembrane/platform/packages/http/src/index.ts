import type { Principal, StaffPolicy } from "@dembrane/access";
import { UnauthenticatedError } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { resolveClientIp } from "./client-ip";

export {
  CLIENT_IP_HEADER,
  type ClientIpOptions,
  PROXY_SECRET_HEADER,
  resolveClientIp,
} from "./client-ip";
export {
  projectAllows,
  projectFor,
  projectSource,
  type Surface,
  workspaceFor,
} from "./project";

/** A signed-in caller as routes see it. */
export interface Signed extends Principal {
  readonly isStaff: boolean;
  /** Set for a staff API key: exactly the staff permissions it holds, instead of all of them. */
  readonly staffPolicies?: readonly StaffPolicy[];
}

/** Per-request values every route can read; set by the API's middleware. */
export type Env = {
  Variables: { requestId: string; logger: Logger; principal: Signed | null; clientIp: string };
};

export type Ctx = Context<Env>;

/** The address the connection came from, or null where the server does not expose it. */
export function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/**
 * The caller's address, for rate limits and records. The API resolves it once per request
 * with its proxy settings; a route mounted without that (a package's own tests) reads the
 * chain with no proxies of ours in it.
 */
// biome-ignore lint/suspicious/noExplicitAny: routes type their context in several ways
export function clientIp(c: Context<any>): string {
  return (
    (c.get("clientIp") as string | undefined) ?? resolveClientIp(c.req.raw.headers, peerAddress(c))
  );
}

/** The signed-in caller, or 401 with the body the old API sends. */
export function requireUser(c: Ctx): Signed {
  const p = c.get("principal");
  if (!p) throw new UnauthenticatedError("auth.session_expired");
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
