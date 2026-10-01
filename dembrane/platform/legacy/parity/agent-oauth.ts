// The OAuth dance as an MCP client performs it, for scenario `prepare` steps: register,
// authorise with PKCE, approve on the consent API as a signed-in person, trade the code.
// Every intermediate answer is returned so the runner compares it on both sides.
import { createHash } from "node:crypto";
import { orgs } from "./fixtures";
import { readBody } from "./runner/clients";
import type { Side, Vars } from "./runner/scenario";

export const VERIFIER = "parity-verifier-0123456789-0123456789-0123456789-abcdef";
export const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
export const REDIRECT = "http://127.0.0.1:9/callback";

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

export async function registerClient(side: Side, metadata: Record<string, unknown> = {}) {
  const res = await side.fetch("/api/mcp/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Parity dance",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      scope: "read write",
      ...metadata,
    }),
  });
  const body = (await readBody(res)) as Record<string, unknown>;
  return {
    status: res.status,
    body,
    clientId: String(body.client_id),
    secret: body.client_secret as string | undefined,
  };
}

/** GET /authorize; returns the consent request id parked for the dashboard. */
export async function startAuthorize(
  side: Side,
  clientId: string,
  extra: Record<string, string> = {},
) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT,
    state: "st-1",
    scope: "read write",
    ...extra,
  });
  const res = await side.fetch(`/api/mcp/authorize?${q}`);
  const location = res.headers.get("location") ?? "";
  await res.text();
  const requestId = new URL(location || "http://x/").searchParams.get("request") ?? "";
  return { status: res.status, location, requestId };
}

async function asUser(side: Side, as: "alice" | "erin" | "bob") {
  const token = await side.login(as);
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** The consent screen's two calls: read the request, then approve it. */
export async function approve(
  side: Side,
  requestId: string,
  as: "alice" | "erin" | "bob" = "alice",
  body: Record<string, unknown> = {
    org_ids: [orgs.a],
    scopes: ["read", "write"],
    expires_in_days: 90,
    consent_accepted: true,
  },
) {
  const headers = await asUser(side, as);
  const view = await side.fetch(`/api/v2/agent-access/authorize-requests/${requestId}`, {
    headers,
  });
  const viewBody = await readBody(view);
  const res = await side.fetch(`/api/v2/agent-access/authorize-requests/${requestId}/approve`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const approved = (await readBody(res)) as { redirect_url?: string };
  const code = approved.redirect_url
    ? (new URL(approved.redirect_url).searchParams.get("code") ?? "")
    : "";
  return {
    view: { status: view.status, body: viewBody },
    approve: { status: res.status, body: approved },
    code,
  };
}

export async function exchange(
  side: Side,
  clientId: string,
  code: string,
  extra: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const init = form({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    ...extra,
  });
  const res = await side.fetch("/api/mcp/token", {
    ...init,
    headers: { ...init.headers, ...headers },
  });
  const body = (await readBody(res)) as Record<string, unknown>;
  return {
    status: res.status,
    body,
    access: String(body.access_token ?? ""),
    refresh: String(body.refresh_token ?? ""),
  };
}

export async function refresh(
  side: Side,
  clientId: string,
  token: string,
  extra: Record<string, string> = {},
) {
  const res = await side.fetch(
    "/api/mcp/token",
    form({ grant_type: "refresh_token", refresh_token: token, client_id: clientId, ...extra }),
  );
  const body = (await readBody(res)) as Record<string, unknown>;
  return {
    status: res.status,
    body,
    access: String(body.access_token ?? ""),
    refresh: String(body.refresh_token ?? ""),
  };
}

/** Register, authorise, approve as Alice and trade the code: a connected public client. */
export async function connect(side: Side, metadata: Record<string, unknown> = {}): Promise<Vars> {
  const reg = await registerClient(side, metadata);
  const auth = await startAuthorize(side, reg.clientId);
  const consent = await approve(side, auth.requestId);
  const tok = await exchange(
    side,
    reg.clientId,
    consent.code,
    reg.secret ? { client_secret: reg.secret } : {},
  );
  return {
    register: { status: reg.status, body: reg.body },
    authorize: { status: auth.status, location: auth.location },
    consent: { view: consent.view, approve: consent.approve },
    token: { status: tok.status, body: tok.body },
    _clientId: reg.clientId,
    _secret: reg.secret,
    _access: tok.access,
    _refresh: tok.refresh,
    _code: consent.code,
  };
}

/** Values that differ per run by construction: secrets, tokens and the registration time. */
export const OAUTH_IGNORE = [
  "access_token",
  "refresh_token",
  "client_secret",
  "client_secret_encrypted",
  "client_id_issued_at",
  "token_hash",
  "duration_ms",
];
