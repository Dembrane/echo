import { createHash, randomUUID } from "node:crypto";
import { newId } from "@echo/core";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  AUTHORIZE_REQUEST_TTL_SECONDS,
  CONSENT_PATH,
  MCP_PATH,
  SCOPE_READ,
  VALID_SCOPES,
} from "./constants";
import { type AgentDeps, grantIsLive } from "./context";
import { jsonErrorText } from "./jsonerror";
import { constructRedirectUri, parseUrl, quotePlus } from "./oauthurl";
import { type ClientSecretBox, mintClientSecret, sameSecret } from "./secrets";
import type { Row } from "./storage";

/**
 * The OAuth 2.1 authorisation server behind agent access, on the agent_client,
 * agent_grant and agent_token tables the Python API wrote, so registered clients and
 * issued tokens keep working across the cutover. It reproduces the MCP Python SDK's
 * endpoint behaviour (dynamic registration, authorise with PKCE S256, token with
 * authorization_code and refresh_token, revocation) and its error texts.
 *
 * Better Auth's OAuth provider plugin was not used: it issues its own token format into
 * its own tables, which would strand every client registered today and cannot reproduce
 * the dashboard consent step (the request is parked, the person approves on the
 * "Connect your agent" page, the grant names organisations and a lifetime).
 *
 * The consent step: `authorize` parks the request and redirects the browser to the
 * dashboard; the signed-in person approves or denies through the management API, which
 * mints a single-use code. Refresh rotates the whole pair; revoking either token kills both.
 */

export interface OAuthDeps extends AgentDeps {
  readonly secrets: ClientSecretBox;
}

/** The API host without a path: deployments give the public URL with or without /api. */
export function apiOrigin(publicUrl: string): string {
  let base = publicUrl.replace(/\/+$/, "");
  if (base.endsWith("/api")) base = base.slice(0, -4);
  return base;
}

export const issuerUrl = (d: AgentDeps) => apiOrigin(d.publicUrl) + MCP_PATH;
export const resourceMetadataUrl = (d: AgentDeps) =>
  `${apiOrigin(d.publicUrl)}/.well-known/oauth-protected-resource${MCP_PATH}`;
const consentUrl = (d: AgentDeps, requestId: string) =>
  `${d.dashboardUrl.replace(/\/+$/, "")}${CONSENT_PATH}?request=${quotePlus(requestId)}`;

export function authorizationServerMetadata(d: AgentDeps) {
  const issuer = issuerUrl(d);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: [...VALID_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    revocation_endpoint: `${issuer}/revoke`,
    revocation_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  };
}

export function protectedResourceMetadata(d: AgentDeps) {
  const issuer = issuerUrl(d);
  return {
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: [SCOPE_READ, "write"],
    bearer_methods_supported: ["header"],
    resource_name: "dembrane MCP",
  };
}

// ── clients ────────────────────────────────────────────────────────────

/** A registered client as the SDK's OAuthClientInformationFull read it back. */
export interface Client {
  readonly client_id: string;
  readonly client_secret: string | null;
  readonly client_name: string | null;
  readonly token_endpoint_auth_method: string | null;
  readonly redirect_uris: string[] | null;
  readonly grant_types: string[];
  readonly scope: string | null;
  readonly client_secret_expires_at: number | null;
}

/**
 * The client, or null when unknown or unreadable (a secret encrypted under another
 * Directus secret, a malformed row): the Python provider treated both as "no client".
 */
export async function loadClient(d: OAuthDeps, clientId: string): Promise<Client | null> {
  const row = await d.store.client(clientId);
  if (!row) return null;
  const meta: Row = { ...((row.metadata as Row | null) ?? {}) };
  let secret: string | null = null;
  if (row.client_secret_encrypted) {
    secret = d.secrets.decrypt(String(row.client_secret_encrypted));
    if (secret === null) {
      d.logger.warn({ client: clientId }, "agent_client secret unreadable");
      return null;
    }
  }
  // Placeholder members (null, "") read as absent, as the SDK model did.
  const present = (k: string) => meta[k] !== null && meta[k] !== undefined && meta[k] !== "";
  const uris =
    present("redirect_uris") && Array.isArray(meta.redirect_uris) ? meta.redirect_uris : null;
  const normalised: string[] = [];
  for (const u of uris ?? []) {
    const p = parseUrl(String(u), { preserveEmptyPath: true });
    if ("error" in p) return null;
    normalised.push(p.href);
  }
  return {
    client_id: String(row.id),
    client_secret: secret || null,
    client_name: present("client_name") ? String(meta.client_name) : null,
    token_endpoint_auth_method: present("token_endpoint_auth_method")
      ? String(meta.token_endpoint_auth_method)
      : null,
    redirect_uris: uris ? normalised : null,
    grant_types:
      present("grant_types") && Array.isArray(meta.grant_types)
        ? meta.grant_types.map(String)
        : ["authorization_code", "refresh_token"],
    scope: present("scope") ? String(meta.scope) : null,
    client_secret_expires_at: present("client_secret_expires_at")
      ? Number(meta.client_secret_expires_at)
      : null,
  };
}

class InvalidRedirect extends Error {}

/** OAuthClientInformationFull.validate_redirect_uri over normalised URLs. */
function redirectFor(client: Client, requested: string | null): string {
  if (requested !== null) {
    if (
      !client.redirect_uris?.includes(requested) &&
      !client.redirect_uris?.map(asRequestUrl).includes(requested)
    )
      throw new InvalidRedirect(`Redirect URI '${requested}' not registered for client`);
    return requested;
  }
  if (client.redirect_uris?.length === 1) return client.redirect_uris[0] as string;
  throw new InvalidRedirect(
    "redirect_uri must be specified unless the client has exactly one registered URI",
  );
}

/** A registered URI as the authorisation request model normalises it (empty path gains "/"). */
function asRequestUrl(u: string): string {
  const p = parseUrl(u);
  return "href" in p ? p.href : u;
}

// ── registration ───────────────────────────────────────────────────────

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic", "private_key_jwt"];
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/**
 * RFC 7591 dynamic registration with the SDK's validation and defaults. Open to anyone,
 * as it was; the route rate-limits it per address (spec L-18).
 */
export async function register(d: OAuthDeps, bodyText: string): Promise<Reply> {
  const bad = (description: string): Reply => ({
    status: 400,
    body: { error: "invalid_client_metadata", error_description: description },
  });
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return bad(`: Invalid JSON: ${jsonErrorText(bodyText)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return bad(": Input should be an object");
  const m = raw as Row;
  const issues: string[] = [];
  const out: Row = {};
  const strField = (k: string) => {
    if (!(k in m) || m[k] === null) out[k] = null;
    else if (typeof m[k] !== "string") issues.push(`${k}: Input should be a valid string`);
    else out[k] = m[k];
  };
  const httpUrl = (k: string) => {
    if (!(k in m) || m[k] === null || m[k] === "") {
      out[k] = null;
      return;
    }
    if (typeof m[k] !== "string") {
      issues.push(`${k}: URL input should be a string or URL`);
      return;
    }
    const p = parseUrl(m[k] as string, { http: true, preserveEmptyPath: true });
    if ("error" in p) issues.push(`${k}: ${p.error}`);
    else out[k] = p.href;
  };
  const strList = (k: string, fallback: string[] | null) => {
    if (!(k in m)) {
      out[k] = fallback;
      return;
    }
    if (m[k] === null && fallback === null) {
      out[k] = null;
      return;
    }
    if (!Array.isArray(m[k])) {
      issues.push(`${k}: Input should be a valid array`);
      return;
    }
    const list = m[k] as unknown[];
    let ok = true;
    list.forEach((v, i) => {
      if (typeof v !== "string") {
        ok = false;
        issues.push(`${k}.${i}: Input should be a valid string`);
      }
    });
    if (ok) out[k] = list;
  };
  // Field order is the SDK model's, which is the order its errors are listed in.
  strList("response_types", ["code"]);
  strField("scope");
  strField("client_name");
  httpUrl("client_uri");
  httpUrl("logo_uri");
  strList("contacts", null);
  httpUrl("tos_uri");
  httpUrl("policy_uri");
  httpUrl("jwks_uri");
  out.jwks = m.jwks ?? null;
  strField("software_id");
  strField("software_version");
  if (!("redirect_uris" in m)) issues.push("redirect_uris: Field required");
  else if (m.redirect_uris === null) out.redirect_uris = null;
  else if (!Array.isArray(m.redirect_uris))
    issues.push("redirect_uris: Input should be a valid array");
  else {
    const uris: string[] = [];
    let ok = true;
    (m.redirect_uris as unknown[]).forEach((u, i) => {
      const p =
        typeof u === "string"
          ? parseUrl(u, { preserveEmptyPath: true })
          : { error: "URL input should be a string or URL" };
      if ("error" in p) {
        ok = false;
        issues.push(`redirect_uris.${i}: ${p.error}`);
      } else uris.push(p.href);
    });
    if (ok && !uris.length)
      issues.push("redirect_uris: List should have at least 1 item after validation, not 0");
    else if (ok) out.redirect_uris = uris;
  }
  if (!("token_endpoint_auth_method" in m) || m.token_endpoint_auth_method === null)
    out.token_endpoint_auth_method = null;
  else if (!AUTH_METHODS.includes(m.token_endpoint_auth_method as string))
    issues.push(
      "token_endpoint_auth_method: Input should be 'none', 'client_secret_post', 'client_secret_basic' or 'private_key_jwt'",
    );
  else out.token_endpoint_auth_method = m.token_endpoint_auth_method;
  if (!("grant_types" in m)) out.grant_types = ["authorization_code", "refresh_token"];
  else if (!Array.isArray(m.grant_types)) issues.push("grant_types: Input should be a valid array");
  else {
    let ok = true;
    (m.grant_types as unknown[]).forEach((g, i) => {
      if (typeof g === "string") return;
      ok = false;
      issues.push(
        `grant_types.${i}.literal['authorization_code','refresh_token','${JWT_BEARER}']: Input should be 'authorization_code', 'refresh_token' or '${JWT_BEARER}'`,
        `grant_types.${i}.str: Input should be a valid string`,
      );
    });
    if (ok) out.grant_types = m.grant_types;
  }
  if (!("application_type" in m)) out.application_type = "native";
  else if (m.application_type !== "web" && m.application_type !== "native")
    issues.push("application_type: Input should be 'web' or 'native'");
  else out.application_type = m.application_type;
  if (issues.length) return bad(issues.join("\n"));

  const clientId = randomUUID();
  if (out.token_endpoint_auth_method === null)
    out.token_endpoint_auth_method = "client_secret_post";
  if (out.token_endpoint_auth_method === "private_key_jwt")
    return bad("token_endpoint_auth_method 'private_key_jwt' is not supported");
  const secret = out.token_endpoint_auth_method !== "none" ? mintClientSecret() : null;
  if (out.scope === null) out.scope = SCOPE_READ;
  else {
    const requested = String(out.scope).split(/\s+/).filter(Boolean);
    const invalid = [
      ...new Set(requested.filter((s) => !(VALID_SCOPES as readonly string[]).includes(s))),
    ];
    if (invalid.length) return bad(`Requested scopes are not valid: ${invalid.join(", ")}`);
  }
  const grants = out.grant_types as string[];
  if (!grants.includes("authorization_code"))
    return bad("grant_types must include 'authorization_code'");
  if (grants.includes(JWT_BEARER))
    return bad(
      `grant_types must not include '${JWT_BEARER}'; the identity-assertion grant requires a pre-registered client`,
    );
  if (!(out.response_types as string[]).includes("code"))
    return bad("response_types must include 'code' for authorization_code grant");

  const now = d.now();
  const issuedAt = Math.floor(now.getTime() / 1000);
  // The stored record and the answer are the whole validated request plus the minted
  // credentials; null and "" members are dropped as the SDK's record model drops them.
  const record: Row = {
    ...out,
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_secret: secret,
    client_secret_expires_at: secret !== null ? 0 : null,
  };
  const info: Row = Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== null && v !== ""),
  );
  const metadata: Row = {
    response_types: info.response_types ?? ["code"],
    scope: info.scope ?? null,
    client_name: info.client_name ?? null,
    client_uri: info.client_uri ?? null,
    logo_uri: info.logo_uri ?? null,
    contacts: info.contacts ?? null,
    tos_uri: info.tos_uri ?? null,
    policy_uri: info.policy_uri ?? null,
    jwks_uri: info.jwks_uri ?? null,
    jwks: info.jwks ?? null,
    software_id: info.software_id ?? null,
    software_version: info.software_version ?? null,
    redirect_uris: info.redirect_uris ?? null,
    token_endpoint_auth_method: info.token_endpoint_auth_method ?? null,
    grant_types: info.grant_types ?? ["authorization_code", "refresh_token"],
    application_type: info.application_type ?? null,
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_secret_expires_at: info.client_secret_expires_at ?? null,
    issuer: null,
  };
  await d.store.createClient({
    id: clientId,
    clientName: (info.client_name as string | undefined) ?? null,
    authMethod: String(info.token_endpoint_auth_method ?? "none"),
    secretEncrypted: secret ? d.secrets.encrypt(secret, now) : null,
    redirectUris: ((info.redirect_uris as string[] | undefined) ?? []).map(String),
    metadata,
    now,
  });
  return { status: 201, body: info };
}

// ── authorise ──────────────────────────────────────────────────────────

/** Request parameters: the query of a GET or the form of a POST; the last value of a key wins. */
export type Params = Record<string, string>;

const NO_STORE = { "cache-control": "no-store" };

/**
 * The SDK's AuthorizationHandler: validate, find the client, settle the redirect URI and
 * scopes, then park the request and send the browser to the consent page. Errors go back
 * to the client's redirect URI when it is known and valid, otherwise as JSON.
 */
export async function authorize(d: OAuthDeps, params: Params): Promise<Reply> {
  let state: string | null = params.state ?? null;
  let client: Client | null = null;
  let redirectUri: string | null = null;

  const errorResponse = async (error: string, description: string, loadClient_ = true) => {
    if (!client && loadClient_ && params.client_id) client = await loadClient(d, params.client_id);
    if (!redirectUri && client) {
      try {
        let raw: string | null = null;
        if ("redirect_uri" in params) {
          const p = parseUrl(params.redirect_uri as string);
          if ("error" in p) throw new InvalidRedirect(p.error);
          raw = p.href;
        }
        redirectUri = redirectFor(client, raw);
      } catch (err) {
        if (!(err instanceof InvalidRedirect)) throw err;
      }
    }
    if (state === null) state = params.state ?? null;
    const body: Row = { error, error_description: description, ...(state !== null && { state }) };
    if (redirectUri && client)
      return {
        status: 302,
        body: null,
        headers: {
          location: constructRedirectUri(redirectUri, body as Record<string, string>),
          ...NO_STORE,
        },
      };
    return { status: 400, body, headers: NO_STORE };
  };

  const issues: string[] = [];
  let literalResponseType = false;
  if (!("client_id" in params)) issues.push("client_id: Field required");
  let requestedRedirect: string | null = null;
  if ("redirect_uri" in params) {
    const p = parseUrl(params.redirect_uri as string);
    if ("error" in p) issues.push(`redirect_uri: ${p.error}`);
    else requestedRedirect = p.href;
  }
  if (!("response_type" in params)) issues.push("response_type: Field required");
  else if (params.response_type !== "code") {
    issues.push("response_type: Input should be 'code'");
    literalResponseType = true;
  }
  if (!("code_challenge" in params)) issues.push("code_challenge: Field required");
  if ("code_challenge_method" in params && params.code_challenge_method !== "S256")
    issues.push("code_challenge_method: Input should be 'S256'");
  if (issues.length)
    return errorResponse(
      literalResponseType ? "unsupported_response_type" : "invalid_request",
      issues.join("\n"),
    );

  const clientId = params.client_id as string;
  client = await loadClient(d, clientId);
  if (!client) return errorResponse("invalid_request", `Client ID '${clientId}' not found`, false);
  try {
    redirectUri = redirectFor(client, requestedRedirect);
  } catch (err) {
    if (err instanceof InvalidRedirect) return errorResponse("invalid_request", err.message);
    throw err;
  }
  let scopes: string[] | null = null;
  if ("scope" in params) {
    scopes = (params.scope as string).split(" ");
    const allowed = client.scope === null ? [] : client.scope.split(" ");
    const missing = scopes.find((s) => !allowed.includes(s));
    if (missing !== undefined)
      return errorResponse("invalid_scope", `Client was not registered with scope ${missing}`);
  }
  const requestId = newId();
  const now = d.now();
  await d.store.park(
    "authz",
    requestId,
    {
      client_id: client.client_id,
      client_name: client.client_name,
      state,
      scopes: scopes?.length ? scopes : [SCOPE_READ],
      code_challenge: params.code_challenge,
      redirect_uri: redirectUri,
      redirect_uri_provided_explicitly: requestedRedirect !== null,
      resource: params.resource ?? null,
      created_at: now.getTime() / 1000,
    },
    AUTHORIZE_REQUEST_TTL_SECONDS,
    now,
  );
  return { status: 302, body: null, headers: { location: consentUrl(d, requestId), ...NO_STORE } };
}

// ── consent outcome (called by the management API) ─────────────────────

export function loadAuthorizeRequest(d: AgentDeps, requestId: string): Promise<Row | null> {
  return d.store.parked("authz", requestId, d.now());
}

export class ExpiredRequest extends Error {
  constructor() {
    super("authorization request expired");
  }
}

/** Creates the grant and the single-use code; returns the redirect back to the client. */
export async function approveAuthorizeRequest(
  d: AgentDeps,
  a: {
    requestId: string;
    appUserId: string;
    directusUserId: string;
    orgIds: string[];
    scopes: string[];
    expiresInDays: number;
    consentVersion: string;
  },
): Promise<string> {
  const now = d.now();
  const pending = await d.store.take("authz", a.requestId, now);
  if (!pending) throw new ExpiredRequest();
  const requested = new Set(
    (Array.isArray(pending.scopes) && pending.scopes.length ? pending.scopes : [SCOPE_READ]).map(
      String,
    ),
  );
  const granted = [...new Set(a.scopes)]
    .filter((s) => requested.has(s) && (VALID_SCOPES as readonly string[]).includes(s))
    .sort();
  if (!granted.includes(SCOPE_READ)) granted.unshift(SCOPE_READ);
  const grantId = await d.store.createGrant({
    appUserId: a.appUserId,
    directusUserId: a.directusUserId,
    clientId: String(pending.client_id),
    clientName: (pending.client_name as string | null) ?? null,
    orgIds: a.orgIds,
    scopes: granted,
    expiresAt: new Date(now.getTime() + a.expiresInDays * 86_400_000),
    consentVersion: a.consentVersion,
    now,
  });
  const code = newId();
  await d.store.park(
    "code",
    code,
    {
      client_id: pending.client_id,
      grant_id: grantId,
      app_user_id: a.appUserId,
      scopes: granted,
      code_challenge: pending.code_challenge ?? null,
      redirect_uri: pending.redirect_uri ?? null,
      redirect_uri_provided_explicitly: pending.redirect_uri_provided_explicitly ?? null,
      resource: pending.resource ?? null,
      expires_at: now.getTime() / 1000 + AUTH_CODE_TTL_SECONDS,
    },
    AUTH_CODE_TTL_SECONDS,
    now,
  );
  return constructRedirectUri(String(pending.redirect_uri), {
    code,
    state: (pending.state as string | null) ?? null,
  });
}

export async function denyAuthorizeRequest(d: AgentDeps, requestId: string): Promise<string> {
  const pending = await d.store.take("authz", requestId, d.now());
  if (!pending) throw new ExpiredRequest();
  return constructRedirectUri(String(pending.redirect_uri), {
    error: "access_denied",
    error_description: "The user declined",
    state: (pending.state as string | null) ?? null,
  });
}

// ── client authentication (token and revoke) ───────────────────────────

class ClientAuthError extends Error {}

/** The SDK's ClientAuthenticator over the form and the Authorization header. */
async function authenticateClient(d: OAuthDeps, form: Params, authorization: string | null) {
  const clientId = form.client_id;
  if (!clientId) throw new ClientAuthError("Missing client_id");
  const client = await loadClient(d, clientId);
  if (!client) throw new ClientAuthError("Invalid client_id");
  let given: string | null = null;
  const header = authorization ?? "";
  if (client.token_endpoint_auth_method === "client_secret_basic") {
    if (!header.startsWith("Basic "))
      throw new ClientAuthError("Missing or invalid Basic authentication in Authorization header");
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    } catch {
      throw new ClientAuthError("Invalid Basic authentication header");
    }
    const at = decoded.indexOf(":");
    if (at < 0) throw new ClientAuthError("Invalid Basic authentication header");
    let basicId: string;
    try {
      basicId = decodeURIComponent(decoded.slice(0, at));
      given = decodeURIComponent(decoded.slice(at + 1));
    } catch {
      throw new ClientAuthError("Invalid Basic authentication header");
    }
    if (basicId !== clientId) throw new ClientAuthError("Client ID mismatch in Basic auth");
  } else if (client.token_endpoint_auth_method === "client_secret_post") {
    given = form.client_secret ?? null;
  } else if (client.token_endpoint_auth_method !== "none") {
    throw new ClientAuthError(
      `Unsupported auth method: ${client.token_endpoint_auth_method ?? "None"}`,
    );
  }
  if (client.token_endpoint_auth_method !== "none" && !client.client_secret)
    throw new ClientAuthError(
      "Client is registered for secret-based authentication but has no stored secret",
    );
  if (client.client_secret) {
    if (!given) throw new ClientAuthError("Client secret is required");
    if (!sameSecret(client.client_secret, given))
      throw new ClientAuthError("Invalid client_secret");
    if (
      client.client_secret_expires_at &&
      client.client_secret_expires_at < Math.floor(d.now().getTime() / 1000)
    )
      throw new ClientAuthError("Client secret has expired");
  }
  return client;
}

// ── tokens ─────────────────────────────────────────────────────────────

/** A verified access token: the grant it acts for. */
export interface AccessToken {
  readonly grantId: string;
  readonly pairId: string;
  readonly clientId: string;
  readonly scopes: string[];
}

/** An access token that is live and whose grant is live, or null. */
export async function verifyAccessToken(d: AgentDeps, raw: string): Promise<AccessToken | null> {
  const now = d.now();
  const row = await d.store.liveToken(raw, "access", now);
  if (!row) return null;
  const grant = await d.store.grant(String(row.grant_id));
  if (!grant || !grantIsLive(grant, now)) return null;
  return {
    grantId: String(grant.id),
    pairId: String(row.pair_id),
    clientId: String(grant.client_id),
    scopes: Array.isArray(grant.scopes) ? grant.scopes.map(String) : [],
  };
}

interface RefreshToken extends AccessToken {
  readonly expiresAt: number | null;
}

/**
 * A live refresh token of this client, or null. With `detectReuse`, a refresh token that
 * was already rotated and is presented again revokes its whole grant (spec L-19: the
 * Python server only refused it, so a stolen token raced the real client indefinitely).
 */
async function loadRefreshToken(
  d: AgentDeps,
  client: Client,
  raw: string,
  detectReuse: boolean,
): Promise<RefreshToken | null> {
  const now = d.now();
  const row = await d.store.liveToken(raw, "refresh", now);
  if (!row) {
    if (detectReuse) {
      const stale = await d.store.anyToken(raw, "refresh");
      if (stale?.revoked_at) {
        const grant = await d.store.grant(String(stale.grant_id));
        if (grant && !grant.revoked_at && String(grant.client_id) === client.client_id) {
          d.logger.warn(
            { grant: String(grant.id) },
            "rotated refresh token replayed; grant revoked",
          );
          await d.store.revokeGrant(String(grant.id), now);
        }
      }
    }
    return null;
  }
  const grant = await d.store.grant(String(row.grant_id));
  if (!grant || !grantIsLive(grant, now) || String(grant.client_id) !== client.client_id)
    return null;
  const expires = Date.parse(String(row.expires_at ?? ""));
  return {
    grantId: String(grant.id),
    pairId: String(row.pair_id),
    clientId: client.client_id,
    scopes: Array.isArray(grant.scopes) ? grant.scopes.map(String) : [],
    expiresAt: Number.isFinite(expires) ? Math.floor(expires / 1000) : null,
  };
}

const TOKEN_HEADERS = { "cache-control": "no-store", pragma: "no-cache" };
const tokenError = (error: string, description: string): Reply => ({
  status: 400,
  body: { error, error_description: description },
  headers: TOKEN_HEADERS,
});

/** Python's repr of a list of strings, as the unsupported-grant message prints it. */
const pyList = (xs: readonly string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;

const GRANT_FIELDS: Record<string, [string, readonly string[]]> = {
  authorization_code: ["authorization_code", ["code", "client_id", "code_verifier"]],
  refresh_token: ["refresh_token", ["refresh_token", "client_id"]],
  [JWT_BEARER]: [JWT_BEARER, ["assertion", "client_id"]],
};

/** POST /token: authorization_code with PKCE, and refresh_token with rotation. */
export async function token(
  d: OAuthDeps,
  form: Params,
  authorization: string | null,
): Promise<Reply> {
  let client: Client;
  try {
    client = await authenticateClient(d, form, authorization);
  } catch (err) {
    if (!(err instanceof ClientAuthError)) throw err;
    return {
      status: 401,
      body: { error: "invalid_client", error_description: err.message },
      headers: TOKEN_HEADERS,
    };
  }
  const grantType = form.grant_type;
  if (grantType === undefined)
    return tokenError(
      "invalid_request",
      ": Unable to extract tag using discriminator 'grant_type'",
    );
  const spec = GRANT_FIELDS[grantType];
  if (!spec)
    return tokenError(
      "invalid_request",
      `: Input tag '${grantType}' found using 'grant_type' does not match any of the expected tags: 'authorization_code', 'refresh_token', '${JWT_BEARER}'`,
    );
  const [tag, required] = spec;
  const issues = required.filter((f) => !(f in form)).map((f) => `${tag}.${f}: Field required`);
  let redirectParam: string | null = null;
  if (grantType === "authorization_code" && "redirect_uri" in form) {
    const p = parseUrl(form.redirect_uri as string);
    if ("error" in p) issues.push(`${tag}.redirect_uri: ${p.error}`);
    else redirectParam = p.href;
  }
  if (issues.length) {
    // pydantic lists fields in model order; redirect_uri sits between code and client_id.
    const order = [
      "code",
      "redirect_uri",
      "refresh_token",
      "assertion",
      "client_id",
      "code_verifier",
    ];
    issues.sort(
      (a, b) =>
        order.indexOf(a.split(".")[1]?.split(":")[0] ?? "") -
        order.indexOf(b.split(".")[1]?.split(":")[0] ?? ""),
    );
    return tokenError("invalid_request", issues.join("\n"));
  }
  if (!client.grant_types.includes(grantType))
    return tokenError(
      "unsupported_grant_type",
      `Unsupported grant type (supported grant types are ${pyList(client.grant_types)})`,
    );
  const now = d.now();

  if (grantType === "authorization_code") {
    const code = form.code as string;
    const data = await d.store.parked("code", code, now);
    if (!data || data.client_id !== client.client_id || client.client_id !== form.client_id)
      return tokenError("invalid_grant", "authorization code does not exist");
    if (Number(data.expires_at ?? 0) < now.getTime() / 1000)
      return tokenError("invalid_grant", "authorization code has expired");
    const authRedirect = data.redirect_uri_provided_explicitly
      ? asRequestUrl(String(data.redirect_uri))
      : null;
    if (redirectParam !== authRedirect)
      return tokenError(
        "invalid_request",
        "redirect_uri did not match the one used when creating auth code",
      );
    const hashed = createHash("sha256")
      .update(form.code_verifier as string)
      .digest("base64url");
    if (hashed !== String(data.code_challenge ?? ""))
      return tokenError("invalid_grant", "incorrect code_verifier");
    const taken = await d.store.take("code", code, now);
    if (!taken) return tokenError("invalid_grant", "authorization code already used");
    const grant = await d.store.grant(String(data.grant_id));
    if (!grant || !grantIsLive(grant, now))
      return tokenError("invalid_grant", "grant is not active");
    const pair = await d.store.mintTokenPair(String(grant.id), now);
    await d.store.touchClient(client.client_id, now);
    const scopes = Array.isArray(grant.scopes) ? grant.scopes.map(String) : [];
    return {
      status: 200,
      body: {
        access_token: pair.access,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: scopes.join(" "),
        refresh_token: pair.refresh,
      },
      headers: TOKEN_HEADERS,
    };
  }

  if (grantType === "refresh_token") {
    const refresh = await loadRefreshToken(d, client, form.refresh_token as string, true);
    if (!refresh || refresh.clientId !== form.client_id)
      return tokenError("invalid_grant", "refresh token does not exist");
    if (refresh.expiresAt && refresh.expiresAt < now.getTime() / 1000)
      return tokenError("invalid_grant", "refresh token has expired");
    const scopes = form.scope ? form.scope.split(" ") : refresh.scopes;
    for (const s of scopes)
      if (!refresh.scopes.includes(s))
        return tokenError(
          "invalid_scope",
          `cannot request scope \`${s}\` not provided by refresh token`,
        );
    const wanted = [...new Set(scopes.length ? scopes : refresh.scopes)].sort();
    await d.store.revokePair(refresh.pairId, now);
    const pair = await d.store.mintTokenPair(refresh.grantId, now);
    await d.store.touchClient(client.client_id, now);
    return {
      status: 200,
      body: {
        access_token: pair.access,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: wanted.join(" "),
        refresh_token: pair.refresh,
      },
      headers: TOKEN_HEADERS,
    };
  }

  // Only reachable for a client whose stored grant types name the JWT bearer grant, which
  // registration refuses: enterprise identity assertions are not offered.
  return tokenError(
    "unsupported_grant_type",
    "The JWT bearer grant is not supported by this authorization server",
  );
}

/** POST /revoke (RFC 7009): an unknown token still answers 200, as the RFC asks. */
export async function revoke(
  d: OAuthDeps,
  form: Params,
  authorization: string | null,
): Promise<Reply> {
  let client: Client;
  try {
    client = await authenticateClient(d, form, authorization);
  } catch (err) {
    if (!(err instanceof ClientAuthError)) throw err;
    return { status: 401, body: { error: "unauthorized_client", error_description: err.message } };
  }
  const issues: string[] = [];
  if (!("token" in form)) issues.push("token: Field required");
  const hint = form.token_type_hint;
  if (hint !== undefined && hint !== "access_token" && hint !== "refresh_token")
    issues.push("token_type_hint: Input should be 'access_token' or 'refresh_token'");
  // The SDK's model declares client_secret without a default, so even a public client
  // must send the field; kept, because clients built against it already do.
  if (!("client_secret" in form)) issues.push("client_secret: Field required");
  if (issues.length)
    return {
      status: 400,
      body: { error: "invalid_request", error_description: issues.join("\n") },
    };
  const raw = form.token as string;
  const loaders = [() => verifyAccessToken(d, raw), () => loadRefreshToken(d, client, raw, false)];
  if (hint === "refresh_token") loaders.reverse();
  let found: AccessToken | null = null;
  for (const load of loaders) {
    found = await load();
    if (found) break;
  }
  if (found && found.clientId === client.client_id) await d.store.revokePair(found.pairId, d.now());
  return { status: 200, body: null, headers: TOKEN_HEADERS };
}
