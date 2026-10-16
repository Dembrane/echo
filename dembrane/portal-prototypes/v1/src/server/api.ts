import type { ApiError, Config } from "../shared/fields";

/**
 * The dembrane API, called as the signed-in person: each call forwards their
 * dashboard session cookie, so the API checks their access as it would for
 * the dashboard.
 */
export type ApiResult<T> = { ok: true; body: T } | ({ ok: false } & ApiError);

async function call<T>(
  env: Env,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { cookie, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(new URL(path, env.VITE_DEV_API_PROXY), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // The API is down or unreachable: callers treat it like a 5xx.
    return { ok: false, status: 503, body: { detail: (error as Error).message } };
  }
  const parsed = await res.json().catch(() => null);
  return res.ok ? { ok: true, body: parsed as T } : { ok: false, status: res.status, body: parsed };
}

export type ApiProject = Config & { id: string; _role?: string };

export const fetchProject = (env: Env, cookie: string, id: string) =>
  call<ApiProject>(
    env,
    cookie,
    "GET",
    `/api/v2/projects/${encodeURIComponent(id)}/bff?include_tags=false`,
  );

/**
 * Whether a project exists, asked as a participant would, with no session. The
 * portal's route answers 404 for a missing project, and 403 for one that
 * exists but isn't taking conversations.
 */
export async function projectExists(env: Env, id: string): Promise<boolean> {
  const res = await call<unknown>(
    env,
    "",
    "GET",
    `/api/participant/projects/${encodeURIComponent(id)}`,
  );
  return res.ok || res.status !== 404;
}

export const patchProject = (env: Env, cookie: string, id: string, fields: Config) =>
  call<ApiProject>(env, cookie, "PATCH", `/api/v2/bff/projects/${encodeURIComponent(id)}`, fields);
