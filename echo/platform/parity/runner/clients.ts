import { users } from "../fixtures";
import type { As, Scenario } from "./scenario";

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
}

export async function call(base: string, token: string | null, s: Scenario): Promise<Captured> {
  const url = new URL(s.path, base);
  for (const [k, v] of Object.entries(s.query ?? {})) url.searchParams.set(k, v);
  const json = typeof s.body === "function" ? (s.body as () => unknown)() : s.body;
  let payload: BodyInit | undefined;
  if (s.form) {
    const form = new FormData();
    for (const [k, v] of Object.entries(s.form)) {
      if (typeof v === "string") form.append(k, v);
      else
        form.append(k, new Blob([Buffer.from(v.base64, "base64")], { type: v.type }), v.filename);
    }
    payload = form;
  } else if (json !== undefined) payload = JSON.stringify(json);
  const res = await fetch(url, {
    method: s.method,
    headers: {
      ...s.headers,
      ...(token && { authorization: `Bearer ${token}` }),
      ...(json !== undefined && !s.form && { "content-type": "application/json" }),
    },
    ...(payload !== undefined && { body: payload }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}
