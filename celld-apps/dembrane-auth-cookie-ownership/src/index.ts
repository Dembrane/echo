import { Hono } from "hono";
import { type AuthEnv, isAdmin, requireAdmin, requireDirectusSession } from "./auth";
import {
  fetchAllOrgs,
  fetchDirectusProfile,
  fetchDirectusUsers,
  fetchMemberships,
  fetchProject,
  fetchProjects,
} from "./directus";
import { canIncrementProjects, canSeeProjects } from "./ownership";

export { Directory } from "./directory";
export { Project } from "./project";
export { User } from "./user";

const app = new Hono<AuthEnv>();

// The one Directory, shared by everyone: always the same name.
const directory = (env: Env) => env.DIRECTORY.getByName("directory");

app.get("/", (c) => c.redirect("/demo-ownership/"));

// Public config for the pages.
app.get("/api/config", (c) => c.json({ directusUrl: c.env.DIRECTUS_PUBLIC_URL }));

// Everything below requires a valid dembrane (Directus) login.
app.use("/api/me", requireDirectusSession);
app.use("/api/users/*", requireDirectusSession); // also matches /api/users
app.use("/api/settings", requireDirectusSession);
app.use("/api/orgs", requireDirectusSession);
app.use("/api/projects/*", requireDirectusSession);

app.get("/api/me", async (c) => {
  const claims = c.get("claims");
  const { id, exp } = claims;
  const user = c.env.USER.getByName(id);
  // The token doesn't carry your name. There's no login step here to fetch it
  // in, so ask Directus (as you) the first time we see you. Best effort: you're
  // still logged in without it.
  let profile = await user.getProfile();
  if (!profile) {
    try {
      profile = await fetchDirectusProfile(c.env.DIRECTUS_URL, c.get("token"));
      await user.setProfile(profile);
    } catch (err) {
      console.warn("couldn't fetch the Directus profile:", err);
    }
  }
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

// ── Organisations and projects ──
//
// The token says nothing about organisations, so the Worker asks Directus on
// every request, with its service token. That way a change of owner applies
// straight away.

// The organisations you're in, with your role in each and their projects.
// Platform admins get every organisation (with role null where they aren't in it).
app.get("/api/orgs", async (c) => {
  const claims = c.get("claims");
  try {
    const memberships = await fetchMemberships(c.env, claims.id);
    const orgs = isAdmin(claims)
      ? (await fetchAllOrgs(c.env)).map((org) => ({ ...org, role: memberships.find((m) => m.id === org.id)?.role ?? null }))
      : memberships;
    const projects = await fetchProjects(c.env, orgs.map((org) => org.id));
    return c.json(
      orgs.map((org) => ({
        ...org,
        canIncrement: canIncrementProjects(claims, org.role),
        projects: projects.filter((p) => p.orgId === org.id).map(({ id, name }) => ({ id, name })),
      })),
    );
  } catch (err) {
    console.warn("couldn't list organisations:", err);
    return c.json({ error: "couldn't reach Directus" }, 502);
  }
});

// Look up a project and your role in its organisation.
async function projectAccess(env: Env, userId: string, projectId: string) {
  const [project, memberships] = await Promise.all([fetchProject(env, projectId), fetchMemberships(env, userId)]);
  return { project, role: memberships.find((m) => m.id === project?.orgId)?.role ?? null };
}

// Anyone in the project's organisation can read its count...
app.get("/api/projects/:id", async (c) => {
  const claims = c.get("claims");
  const { project, role } = await projectAccess(c.env, claims.id, c.req.param("id"));
  // A 404 either way, so as not to reveal which projects exist.
  if (!project || !canSeeProjects(claims, role)) return c.json({ error: "no such project" }, 404);
  const count = await c.env.PROJECT.getByName(project.id).getCount();
  return c.json({ id: project.id, count });
});

// ...but only its owner can increment it (platform admins can increment any).
app.post("/api/projects/:id/increment", async (c) => {
  const claims = c.get("claims");
  const { project, role } = await projectAccess(c.env, claims.id, c.req.param("id"));
  if (!project || !canSeeProjects(claims, role)) return c.json({ error: "no such project" }, 404);
  if (!canIncrementProjects(claims, role)) {
    return c.json({ error: "only the organisation's owner can increment its projects" }, 403);
  }
  const count = await c.env.PROJECT.getByName(project.id).increment();
  return c.json({ id: project.id, count });
});

// Anything thrown, such as Directus being unreachable, as JSON for the page.
app.onError((err, c) => {
  console.warn(err);
  return c.json({ error: "something went wrong (is Directus running?)" }, 500);
});

// celld has no directory index: /dir/ falls through to here, so serve
// /dir/index.html for it.
app.get("*", (c) => (c.req.path.endsWith("/") ? c.env.ASSETS.fetch(new URL("index.html", c.req.url)) : c.notFound()));

export default app;
