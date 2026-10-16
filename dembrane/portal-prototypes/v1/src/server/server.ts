import { getAgentByName } from "agents";
import { type Context, Hono } from "hono";
import { type Config, FIELD_KEYS } from "../shared/fields";
import { fetchProject } from "./api";
import type { ConfigResult } from "./project.do";

export { ProjectConfig } from "./project.do";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

// The page checks its dashboard session through here, same-origin, as the
// dashboard's own Vite proxy lets it. It's the only part of /api/ passed through.
app.all("/api/auth/*", (c) => {
  const url = new URL(c.req.url);
  const target = new URL(url.pathname + url.search, c.env.VITE_DEV_API_PROXY);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  return fetch(target, {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    redirect: "manual",
  });
});

app.get("/api/config", (c) => c.json({ dashboardUrl: c.env.DASHBOARD_URL }));

/** The signed-in person, from the session cookie the request carries. */
async function signedIn(c: Context<AppEnv>) {
  const cookie = c.req.header("cookie") ?? "";
  if (!cookie) return null;
  const res = await fetch(new URL("/api/auth/get-session", c.env.VITE_DEV_API_PROXY), {
    headers: { cookie },
  }).catch(() => null);
  if (!res?.ok) return null;
  const session = (await res.json().catch(() => null)) as { user?: { id?: string } } | null;
  const userId = session?.user?.id;
  return userId ? { cookie, userId } : null;
}

const unauthenticated = (c: Context<AppEnv>) =>
  c.json({ detail: "Sign in on the dashboard first", code: "auth.token_required" }, 401);

const reply = (c: Context<AppEnv>, result: ConfigResult) =>
  result.ok
    ? c.json(result.view)
    : c.json(result.body as object, result.status as 400 | 401 | 403 | 404 | 422 | 500);

/**
 * Whether the visitor is one of the project's hosts: signed in on the
 * dashboard, and let in by the API. Anyone else is a participant.
 */
app.get("/api/projects/:id/access", async (c) => {
  const who = await signedIn(c);
  if (!who) return c.json({ host: false, role: null });
  const res = await fetchProject(c.env, who.cookie, c.req.param("id"));
  return c.json(
    res.ok ? { host: true, role: res.body._role ?? null } : { host: false, role: null },
  );
});

app.get("/api/projects/:id/config", async (c) => {
  const who = await signedIn(c);
  if (!who) return unauthenticated(c);
  const project = await getAgentByName(c.env.ProjectConfig, c.req.param("id"));
  return reply(c, await project.load(who.cookie, who.userId));
});

app.patch("/api/projects/:id/config", async (c) => {
  const who = await signedIn(c);
  if (!who) return unauthenticated(c);
  const body = (await c.req.json().catch(() => null)) as Config | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ detail: "Expected a JSON object of fields" }, 400);
  }
  const fields = Object.fromEntries(Object.entries(body).filter(([k]) => FIELD_KEYS.has(k)));
  if (!Object.keys(fields).length) return c.json({ detail: "Nothing to update" }, 400);
  const project = await getAgentByName(c.env.ProjectConfig, c.req.param("id"));
  return reply(c, await project.update(who.cookie, who.userId, fields));
});

export default app;
