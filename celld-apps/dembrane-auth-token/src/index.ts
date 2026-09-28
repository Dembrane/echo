import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { type AuthEnv, SESSION_COOKIE, isAdmin, requireAdmin, requireDirectusSession, verifyDirectusToken } from "./auth";
import { fetchDirectusProfile, fetchDirectusUsers } from "./directus";

export { Directory } from "./directory";
export { User } from "./user";

const app = new Hono<AuthEnv>();

// The one Directory, shared by everyone: always the same name.
const directory = (env: Env) => env.DIRECTORY.getByName("directory");

app.get("/", (c) => c.redirect("/dembrane-dashboard/"));

// Public config for the pages.
app.get("/api/config", (c) => c.json({ directusUrl: c.env.DIRECTUS_PUBLIC_URL }));

// The link handoff: trade the token from the link for our own cookie.
app.post("/api/session", async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  let claims;
  try {
    claims = await verifyDirectusToken(token, c.env.DIRECTUS_SECRET);
  } catch {
    return c.json({ error: "invalid or expired token" }, 401);
  }
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: claims.exp - Math.floor(Date.now() / 1000),
  });
  // Fetch the details the token doesn't carry, while we hold a token to ask
  // with. Best effort: the login works without it.
  try {
    const profile = await fetchDirectusProfile(c.env.DIRECTUS_URL, token);
    await c.env.USER.getByName(claims.id).setProfile(profile);
  } catch (err) {
    console.warn("couldn't fetch the Directus profile:", err);
  }
  return c.json({ id: claims.id });
});

app.delete("/api/session", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});

// Everything below requires a valid dembrane (Directus) login.
app.use("/api/me", requireDirectusSession);
app.use("/api/users/*", requireDirectusSession); // also matches /api/users
app.use("/api/settings", requireDirectusSession);

app.get("/api/me", async (c) => {
  const claims = c.get("claims");
  const { id, exp } = claims;
  const profile = await c.env.USER.getByName(id).getProfile();
  return c.json({ id, isAdmin: isAdmin(claims), exp, name: profile?.name ?? null, email: profile?.email ?? null });
});

// Anyone logged in can read the settings (the page needs them)...
app.get("/api/settings", async (c) => c.json(await directory(c.env).getSettings()));

// ...but only admins can change them.
app.put("/api/settings", requireAdmin, async (c) => {
  const { usersCanSeeEachOther } = await c.req.json<{ usersCanSeeEachOther: unknown }>();
  if (typeof usersCanSeeEachOther !== "boolean") {
    return c.json({ error: "usersCanSeeEachOther must be true or false" }, 400);
  }
  return c.json(await directory(c.env).setSettings({ usersCanSeeEachOther }));
});

// The saved list of users. Admins can always read it; everyone else only while
// an admin allows non-admins to see other users.
app.get("/api/users", async (c) => {
  const dir = directory(c.env);
  if (!isAdmin(c.get("claims")) && !(await dir.getSettings()).usersCanSeeEachOther) {
    return c.json({ error: "only platform admins can list users" }, 403);
  }
  return c.json(await dir.getSnapshot());
});

// Admins only: fetch every Directus user again and save the list, asking with
// the admin's own token. The Worker checks admin_access itself rather than
// leaving it to Directus (which would answer anyone else with just themselves)
// or to the page.
app.post("/api/users/refresh", requireAdmin, async (c) => {
  let users;
  try {
    users = await fetchDirectusUsers(c.env.DIRECTUS_URL, c.get("token"));
  } catch (err) {
    console.warn("couldn't list Directus users:", err);
    return c.json({ error: "couldn't reach Directus" }, 502);
  }
  return c.json(await directory(c.env).setUsers(users));
});

// Anyone logged in can read anyone's count...
app.get("/api/users/:id", async (c) => {
  const id = c.req.param("id");
  const count = await c.env.USER.getByName(id).getCount();
  return c.json({ id, count });
});

// ...but only you can increment yours (admins can increment anyone's).
app.post("/api/users/:id/increment", async (c) => {
  const id = c.req.param("id");
  const claims = c.get("claims");
  if (id !== claims.id && !isAdmin(claims)) {
    return c.json({ error: "you can only increment your own counter" }, 403);
  }
  const count = await c.env.USER.getByName(id).increment();
  return c.json({ id, count });
});

// celld has no directory index: /dir/ falls through to here, so serve
// /dir/index.html for it.
app.get("*", (c) => (c.req.path.endsWith("/") ? c.env.ASSETS.fetch(new URL("index.html", c.req.url)) : c.notFound()));

export default app;
