// The Worker's calls to Directus, for user details the token doesn't carry
// (name, email). Each is made as the user: the Worker passes on their own
// access token, so Directus applies that user's permissions and the Worker
// needs no credentials of its own.

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
