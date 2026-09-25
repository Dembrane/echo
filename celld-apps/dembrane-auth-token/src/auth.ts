import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";

// The Worker's own cookie, set by POST /api/session after the link handoff.
// (It can't use dembrane's `dembrane_session_token` cookie: that one is for
// .dembrane.com, a different domain, so the browser never sends it here.)
export const SESSION_COOKIE = "demo_session_cookie";

// The claims Directus puts in its JWTs. dembrane's backend reads `id` and
// `admin_access` (see require_directus_session in dependency_auth.py); so do we.
export type DirectusClaims = {
  id: string;
  role?: string | null;
  app_access?: boolean;
  admin_access?: boolean;
  iat: number;
  exp: number;
  iss?: string;
};

export type AuthEnv = {
  Bindings: Env;
  // Set by requireDirectusSession. `token` is kept so the Worker can pass it
  // on to Directus and ask as this user.
  Variables: { claims: DirectusClaims; token: string };
};

export async function verifyDirectusToken(token: string, secret: string) {
  return (await verify(token, secret, "HS256")) as DirectusClaims;
}

export const isAdmin = (claims: DirectusClaims) => claims.admin_access === true;

// The TypeScript twin of FastAPI's `require_directus_session`: an HS256 JWT
// signed with DIRECTUS_SECRET, from `Authorization: Bearer` (like the iOS app)
// or from our session cookie (like the browser). Anything else → 401.
export const requireDirectusSession = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "not logged in" }, 401);
  try {
    c.set("claims", await verifyDirectusToken(token, c.env.DIRECTUS_SECRET));
  } catch {
    return c.json({ error: "invalid or expired token" }, 401);
  }
  c.set("token", token);
  await next();
});

// Use after requireDirectusSession. Anyone who isn't an admin → 403.
export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  if (!isAdmin(c.get("claims"))) return c.json({ error: "platform admins only" }, 403);
  await next();
});
