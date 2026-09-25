import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";

// Directus's own session cookie (its SESSION_COOKIE_NAME), set when you log in
// with `mode: "session"`. The Worker never sets it; it only reads it. The
// browser sends it here because the Worker is inside the cookie's domain:
// .dembrane.com in production, and localhost locally (cookies ignore the port).
export const SESSION_COOKIE = "dembrane_session_token";

// The claims Directus puts in its JWTs. dembrane's backend reads `id` and
// `admin_access` (see require_directus_session in dependency_auth.py); so do we.
// Session tokens also carry `session`, which Directus uses to refresh them.
export type DirectusClaims = {
  id: string;
  role?: string | null;
  app_access?: boolean;
  admin_access?: boolean;
  session?: string;
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

// The browser attaches the cookie by itself, even to a request started by
// another page in the cookie's domain (another *.dembrane.com host, or another
// localhost port).
// So a request that changes something, authenticated by the cookie alone, must
// come from our own pages. A Bearer token can't be attached that way.
const isSafeMethod = (method: string) => method === "GET" || method === "HEAD" || method === "OPTIONS";
const fromOurOrigin = (req: Request) =>
  req.headers.get("sec-fetch-site") === "same-origin" || req.headers.get("origin") === new URL(req.url).origin;

// The TypeScript twin of FastAPI's `require_directus_session`: an HS256 JWT
// signed with DIRECTUS_SECRET, from `Authorization: Bearer` (like the iOS app)
// or from Directus's session cookie (like the browser). Anything else → 401.
export const requireDirectusSession = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const token = bearer ?? getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "not logged in" }, 401);
  if (!bearer && !isSafeMethod(c.req.method) && !fromOurOrigin(c.req.raw)) {
    return c.json({ error: "cross-origin request" }, 403);
  }
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
