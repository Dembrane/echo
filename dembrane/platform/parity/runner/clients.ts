import { users } from "../fixtures";
import type { As, Scenario, Side, Vars } from "./scenario";

export const OLD = process.env.PARITY_OLD_URL ?? "http://127.0.0.1:8100";
export const NEW = process.env.PARITY_NEW_URL ?? "http://127.0.0.1:8200";
const DIRECTUS = "http://127.0.0.1:8065";

/** Every seeded user shares one password; PARITY_ADMIN_PASSWORD is Directus's bootstrap admin, not a fixture. */
function password(_as: As): string {
  const p = process.env.PARITY_USER_PASSWORD;
  if (!p) throw new Error("load parity/.env.parity first");
  return p;
}

/** Old stack: a Directus access token, the way the dashboard and iOS app authenticate today. */
export async function oldToken(as: As): Promise<string | null> {
  if (as === "anonymous") return null;
  const res = await fetch(`${DIRECTUS}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: users[as].email, password: password(as) }),
  });
  if (!res.ok) throw new Error(`directus login ${as}: ${res.status}`);
  return ((await res.json()) as { data: { access_token: string } }).data.access_token;
}

/** New stack: a Better Auth session token used as a bearer. */
export async function newToken(as: As): Promise<string | null> {
  if (as === "anonymous") return null;
  const res = await fetch(`${NEW}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ email: users[as].email, password: password(as) }),
  });
  if (!res.ok) throw new Error(`better-auth sign-in ${as}: ${res.status} ${await res.text()}`);
  return res.headers.get("set-auth-token") ?? ((await res.json()) as { token: string }).token;
}

export interface Captured {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string | null>;
}

export function sideOf(base: string, login: (as: As) => Promise<string | null>): Side {
  return {
    base,
    login,
    fetch: (path, init) => fetch(new URL(path, base), { redirect: "manual", ...init }),
  };
}

/** Parses a response body the way `call` does: JSON when it is JSON, else the text. */
export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const resolve = <T>(v: T | ((vars: Vars) => T), vars: Vars): T =>
  typeof v === "function" ? (v as (vars: Vars) => T)(vars) : v;

export async function call(
  base: string,
  token: string | null,
  s: Scenario,
  vars: Vars = {},
): Promise<Captured> {
  const url = new URL(resolve(s.path, vars), base);
  for (const [k, v] of Object.entries(resolve(s.query, vars) ?? {})) url.searchParams.set(k, v);
  const json = typeof s.body === "function" ? await (s.body as (v: Vars) => unknown)(vars) : s.body;
  const formFields = resolve(s.form, vars);
  const urlencoded = resolve(s.urlencoded, vars);
  const raw = resolve(s.raw, vars);
  let payload: RequestInit["body"] | undefined;
  if (raw !== undefined) {
    payload = raw;
  } else if (urlencoded) {
    payload = new URLSearchParams(urlencoded).toString();
  } else if (formFields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(formFields)) {
      if (typeof v === "string") form.append(k, v);
      else
        form.append(k, new Blob([Buffer.from(v.base64, "base64")], { type: v.type }), v.filename);
    }
    payload = form;
  } else if (json !== undefined) payload = JSON.stringify(json);
  const res = await fetch(url, {
    method: s.method,
    // Only scenarios that compare headers see redirects unfollowed, so older ones keep
    // following them as they always did.
    ...(s.responseHeaders && { redirect: "manual" as const }),
    headers: {
      ...(json !== undefined && !formFields && { "content-type": "application/json" }),
      ...(urlencoded && { "content-type": "application/x-www-form-urlencoded" }),
      ...resolve(s.headers, vars),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    ...(payload !== undefined && { body: payload }),
  });
  const body = await readBody(res);
  if (!s.responseHeaders) return { status: res.status, body };
  const headers = Object.fromEntries(
    s.responseHeaders.map((h) => [h.toLowerCase(), res.headers.get(h)]),
  );
  return { status: res.status, body, headers };
}
