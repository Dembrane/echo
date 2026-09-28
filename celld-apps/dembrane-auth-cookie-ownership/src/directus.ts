import type { OrgRole } from "./ownership";

// The Worker's calls to Directus, for what the token doesn't carry.
// User details (name, email) are asked for as the user: the Worker passes on
// their own session token as a Bearer token, so Directus applies that user's
// permissions. Organisations and projects need the Worker's own service token
// (see below).

export type Profile = { name: string | null; email: string | null };
export type DirectoryUser = Profile & { id: string };

type DirectusUser = { id: string; first_name?: string | null; last_name?: string | null; email?: string | null };

const toProfile = (user: DirectusUser): Profile => ({
  name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
  email: user.email ?? null,
});

async function directusGet<T>(directusUrl: string, path: string, token: string): Promise<T> {
  const res = await fetch(`${directusUrl.replace(/\/$/, "")}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Directus ${path}: HTTP ${res.status}`);
  return (await res.json<{ data: T }>()).data;
}

export async function fetchDirectusProfile(directusUrl: string, token: string): Promise<Profile> {
  // `fields=*` returns only the fields this user's role may read, where naming a
  // forbidden field would fail the whole request.
  return toProfile(await directusGet<DirectusUser>(directusUrl, "/users/me?fields=*", token));
}

// Every Directus user. Only an admin's token gets them all; Directus returns
// anyone else just themselves (the Worker doesn't rely on that; see POST /api/users/refresh).
export async function fetchDirectusUsers(directusUrl: string, token: string): Promise<DirectoryUser[]> {
  const users = await directusGet<DirectusUser[]>(
    directusUrl,
    "/users?fields=id,first_name,last_name,email&sort=first_name&limit=-1",
    token,
  );
  return users.map((user) => ({ id: user.id, ...toProfile(user) }));
}

// ── Organisations and projects ──
//
// dembrane's Basic User role can't read org, org_membership or project, so
// unlike the calls above these can't be made with the user's own token. The
// Worker uses a service token (DIRECTUS_TOKEN), as dembrane's backend does
// (the admin client in echo/server/dembrane/directus_async.py), and applies
// the rules itself (see ownership.ts).

export type Org = { id: string; name: string };
export type Membership = Org & { role: OrgRole };
export type ProjectInfo = { id: string; name: string; orgId: string };

// Anything other than "owner" counts as "member" (see OrgRole).
const toRole = (role: string): OrgRole => (role === "owner" ? "owner" : "member");

// The organisations this user is in, and their role in each. Memberships point
// at app_user, which points at directus_users, so one filter follows both.
export async function fetchMemberships(env: Env, directusUserId: string): Promise<Membership[]> {
  const q = new URLSearchParams({
    "filter[user_id][directus_user_id][_eq]": directusUserId,
    "filter[deleted_at][_null]": "true",
    fields: "role,org_id.id,org_id.name",
  });
  const rows = await directusGet<{ role: string; org_id: Org }[]>(env.DIRECTUS_URL, `/items/org_membership?${q}`, env.DIRECTUS_TOKEN);
  return rows.map((row) => ({ ...row.org_id, role: toRole(row.role) }));
}

// Every organisation, for platform admins.
export async function fetchAllOrgs(env: Env): Promise<Org[]> {
  const q = new URLSearchParams({ "filter[deleted_at][_null]": "true", fields: "id,name", sort: "name", limit: "-1" });
  return directusGet<Org[]>(env.DIRECTUS_URL, `/items/org?${q}`, env.DIRECTUS_TOKEN);
}

// Projects belong to a workspace, and workspaces to an organisation.
type DirectusProject = { id: string; name: string | null; workspace_id: { org_id: string } | null };

const toProject = (project: DirectusProject): ProjectInfo | null =>
  project.workspace_id && { id: project.id, name: project.name ?? "Untitled project", orgId: project.workspace_id.org_id };

export async function fetchProjects(env: Env, orgIds: string[]): Promise<ProjectInfo[]> {
  if (orgIds.length === 0) return [];
  const q = new URLSearchParams({
    "filter[workspace_id][org_id][_in]": orgIds.join(","),
    "filter[deleted_at][_null]": "true",
    fields: "id,name,workspace_id.org_id",
    sort: "name",
    limit: "-1",
  });
  const projects = await directusGet<DirectusProject[]>(env.DIRECTUS_URL, `/items/project?${q}`, env.DIRECTUS_TOKEN);
  return projects.map(toProject).filter((project) => project !== null);
}

// One project, or null if there's no such project (or it's in no workspace).
export async function fetchProject(env: Env, projectId: string): Promise<ProjectInfo | null> {
  const q = new URLSearchParams({
    "filter[id][_eq]": projectId,
    "filter[deleted_at][_null]": "true",
    fields: "id,name,workspace_id.org_id",
  });
  const [project] = await directusGet<DirectusProject[]>(env.DIRECTUS_URL, `/items/project?${q}`, env.DIRECTUS_TOKEN);
  return project ? toProject(project) : null;
}
