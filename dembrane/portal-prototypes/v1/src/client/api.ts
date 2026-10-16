import type { ApiError, Config, ConfigView } from "../shared/fields";

// As the dashboard's API_BASE_URL is locally (dembrane/frontend/src/config.ts):
// same-origin, with the Worker in front.
const API_BASE_URL = "/api";

export type Result<T> = { ok: true; body: T } | ({ ok: false } & ApiError);

async function call<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  const res = await fetch(`${API_BASE_URL}${path}`, { credentials: "include", ...init });
  const body = await res.json().catch(() => null);
  return res.ok ? { ok: true, body: body as T } : { ok: false, status: res.status, body };
}

export type Session = { user: { id: string; email: string; name?: string } } | null;

export const getSession = () => call<Session>("/auth/get-session");

export const getAppConfig = () => call<{ dashboardUrl: string }>("/config");

export const getAccess = (projectId: string) =>
  call<{ host: boolean; role: string | null }>(`/projects/${encodeURIComponent(projectId)}/access`);

export const getConfig = (projectId: string) =>
  call<ConfigView>(`/projects/${encodeURIComponent(projectId)}/config`);

export const saveConfig = (projectId: string, fields: Config) =>
  call<ConfigView>(`/projects/${encodeURIComponent(projectId)}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });

/** Field errors from a 422, keyed by field, as the API's validator words them. */
export function fieldErrors(error: ApiError): Record<string, string> {
  const out: Record<string, string> = {};
  const detail = (error.body as { detail?: unknown } | null)?.detail;
  if (error.status !== 422 || !Array.isArray(detail)) return out;
  for (const d of detail as { loc?: unknown[]; msg?: string }[]) {
    const key = d.loc?.at(-1);
    if (typeof key === "string") out[key] = d.msg ?? "Invalid value";
  }
  return out;
}

/** One line for an error that isn't about a single field. */
export function errorMessage(error: ApiError): string {
  const body = error.body as { detail?: unknown; code?: unknown } | null;
  if (typeof body?.detail === "string") return body.detail;
  if (typeof body?.code === "string") return body.code;
  return `The API answered ${error.status}`;
}
