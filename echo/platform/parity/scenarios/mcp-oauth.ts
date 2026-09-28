// The OAuth authorisation server behind MCP: metadata, dynamic registration, authorise
// with PKCE, the dashboard consent step, token exchange, refresh, revocation, and tokens
// and clients minted by the Python API used against the side under test.
import {
  approve,
  CHALLENGE,
  connect,
  OAUTH_IGNORE,
  REDIRECT,
  refresh,
  registerClient,
  startAuthorize,
  VERIFIER,
} from "../agent-oauth";
import { AGENT_GRANTS } from "../agent-setup";
import { agent, orgs } from "../fixtures";
import { type Scenario, scenarios, type Vars } from "../runner/scenario";

const ignoreFields = OAUTH_IGNORE;
const MCP_HEADERS = (token: string) => ({
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${token}`,
});
const WHOAMI = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "dembrane_whoami", arguments: {} },
};

const oauth = (s: Omit<Scenario, "as"> & { as?: Scenario["as"] }): Scenario => ({
  as: "anonymous",
  ignoreFields,
  ...s,
  name: `oauth: ${s.name}`,
});

const authorizeQuery = (extra: Record<string, string> = {}) => ({
  client_id: agent.client,
  response_type: "code",
  code_challenge: CHALLENGE,
  redirect_uri: REDIRECT,
  state: "st-1",
  ...extra,
});

export default scenarios([
  // ── metadata ─────────────────────────────────────────────────────────
  oauth({
    name: "server metadata",
    method: "GET",
    path: "/.well-known/oauth-authorization-server/api/mcp",
    responseHeaders: ["cache-control"],
  }),
  oauth({
    name: "server metadata path form",
    method: "GET",
    path: "/api/mcp/.well-known/oauth-authorization-server",
  }),
  oauth({
    name: "resource metadata",
    method: "GET",
    path: "/.well-known/oauth-protected-resource/api/mcp",
    responseHeaders: ["cache-control"],
  }),
  oauth({
    name: "token preflight from the dashboard",
    method: "OPTIONS",
    path: "/api/mcp/token",
    headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
    responseHeaders: ["access-control-allow-origin"],
    differs:
      "preflights follow the app-wide CORS policy on both sides (same origins); the platform answers 204 with no body where Starlette answered 200 OK",
  }),
  oauth({
    name: "metadata preflight from elsewhere",
    method: "OPTIONS",
    path: "/.well-known/oauth-authorization-server/api/mcp",
    headers: { origin: "http://inspector.test", "access-control-request-method": "GET" },
    responseHeaders: ["access-control-allow-origin"],
    differs:
      "the platform's CORS policy covers /api/* only, so a preflight on the root metadata path gets the public document instead of 400 Disallowed CORS origin",
  }),

  // ── registration ─────────────────────────────────────────────────────
  oauth({
    name: "register public client",
    method: "POST",
    path: "/api/mcp/register",
    body: {
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  }),
  oauth({
    name: "register confidential by default",
    method: "POST",
    path: "/api/mcp/register",
    body: {
      redirect_uris: ["http://localhost:6274/oauth/callback"],
      scope: "read write",
      client_uri: "https://inspector.example",
      contacts: ["a@example.com"],
    },
  }),
  oauth({
    name: "register missing redirect",
    method: "POST",
    path: "/api/mcp/register",
    body: { client_name: "x" },
  }),
  oauth({
    name: "register empty redirect",
    method: "POST",
    path: "/api/mcp/register",
    body: { redirect_uris: [] },
  }),
  oauth({
    name: "register relative redirect",
    method: "POST",
    path: "/api/mcp/register",
    body: { redirect_uris: ["callback"], client_uri: "ftp://x" },
  }),
  oauth({
    name: "register private key jwt",
    method: "POST",
    path: "/api/mcp/register",
    body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt" },
  }),
  oauth({
    name: "register bad method",
    method: "POST",
    path: "/api/mcp/register",
    body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: "magic" },
  }),
  oauth({
    name: "register unknown scope",
    method: "POST",
    path: "/api/mcp/register",
    body: { redirect_uris: [REDIRECT], scope: "read admin" },
  }),
  oauth({
    name: "register without code grant",
    method: "POST",
    path: "/api/mcp/register",
    body: { redirect_uris: [REDIRECT], grant_types: ["refresh_token"] },
  }),
  oauth({
    name: "register jwt bearer grant",
    method: "POST",
    path: "/api/mcp/register",
    body: {
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
    },
  }),
  oauth({
    name: "register without code response",
    method: "POST",
    path: "/api/mcp/register",
    body: { redirect_uris: [REDIRECT], response_types: ["token"] },
  }),
  oauth({
    name: "register bad json",
    method: "POST",
    path: "/api/mcp/register",
    raw: "garbage",
    headers: { "content-type": "application/json" },
  }),
  oauth({ name: "register array", method: "POST", path: "/api/mcp/register", body: [] }),

  // ── authorise ────────────────────────────────────────────────────────
  oauth({
    name: "authorize parks the request",
    method: "GET",
    path: "/api/mcp/authorize",
    query: authorizeQuery(),
    responseHeaders: ["location", "cache-control"],
  }),
  oauth({
    name: "authorize by form post",
    method: "POST",
    path: "/api/mcp/authorize",
    urlencoded: authorizeQuery(),
    responseHeaders: ["location"],
  }),
  oauth({
    name: "authorize implicit redirect",
    method: "GET",
    path: "/api/mcp/authorize",
    query: { client_id: agent.client, response_type: "code", code_challenge: CHALLENGE },
    responseHeaders: ["location"],
  }),
  oauth({
    name: "authorize nothing",
    method: "GET",
    path: "/api/mcp/authorize",
    responseHeaders: ["location"],
  }),
  oauth({
    name: "authorize token response type",
    method: "GET",
    path: "/api/mcp/authorize",
    query: authorizeQuery({ response_type: "token" }),
    responseHeaders: ["location"],
  }),
  oauth({
    name: "authorize plain challenge",
    method: "GET",
    path: "/api/mcp/authorize",
    query: authorizeQuery({ code_challenge_method: "plain" }),
    responseHeaders: ["location"],
  }),
  oauth({
    name: "authorize unknown client",
    method: "GET",
    path: "/api/mcp/authorize",
    query: authorizeQuery({ client_id: "c0ffee00-0000-4000-8000-000000000000" }),
    responseHeaders: ["location"],
  }),
  oauth({
    name: "authorize unregistered redirect",
    method: "GET",
    path: "/api/mcp/authorize",
    query: authorizeQuery({ redirect_uri: "https://evil.example/cb" }),
    responseHeaders: ["location"],
  }),
  oauth({
    name: "authorize scope the client lacks",
    method: "GET",
    path: "/api/mcp/authorize",
    query: authorizeQuery({ scope: "read" }),
    responseHeaders: ["location"],
  }),

  // ── consent ──────────────────────────────────────────────────────────
  oauth({
    name: "consent view",
    method: "GET",
    path: (v) => `/api/v2/agent-access/authorize-requests/${v._req}`,
    as: "alice",
    prepare: async (side) => {
      const reg = await registerClient(side);
      const auth = await startAuthorize(side, reg.clientId);
      return { register: { status: reg.status, body: reg.body }, _req: auth.requestId };
    },
  }),
  oauth({
    name: "consent deny",
    method: "POST",
    path: (v) => `/api/v2/agent-access/authorize-requests/${v._req}/deny`,
    as: "alice",
    prepare: async (side) => {
      const reg = await registerClient(side);
      const auth = await startAuthorize(side, reg.clientId);
      return { _req: auth.requestId };
    },
  }),
  oauth({
    name: "consent approve twice",
    method: "POST",
    path: (v) => `/api/v2/agent-access/authorize-requests/${v._req}/approve`,
    as: "alice",
    body: { org_ids: [orgs.a], consent_accepted: true },
    prepare: async (side) => {
      const reg = await registerClient(side);
      const auth = await startAuthorize(side, reg.clientId);
      const first = await approve(side, auth.requestId);
      return { first: first.approve, _req: auth.requestId };
    },
  }),
  oauth({
    name: "consent read-only by default",
    method: "POST",
    path: (v) => `/api/v2/agent-access/authorize-requests/${v._req}/approve`,
    as: "erin",
    body: { org_ids: [orgs.a, orgs.b], consent_accepted: true, expires_in_days: 30 },
    prepare: async (side) => {
      const reg = await registerClient(side);
      const auth = await startAuthorize(side, reg.clientId);
      return { _req: auth.requestId };
    },
  }),
  oauth({
    name: "consent without accepting",
    method: "POST",
    path: (v) => `/api/v2/agent-access/authorize-requests/${v._req}/approve`,
    as: "alice",
    body: { org_ids: [orgs.a], consent_accepted: false },
    prepare: async (side) => ({
      _req: (await startAuthorize(side, (await registerClient(side)).clientId)).requestId,
    }),
  }),
  oauth({
    name: "consent odd expiry",
    method: "POST",
    path: (v) => `/api/v2/agent-access/authorize-requests/${v._req}/approve`,
    as: "alice",
    body: { org_ids: [orgs.a], consent_accepted: true, expires_in_days: 7 },
    prepare: async (side) => ({
      _req: (await startAuthorize(side, (await registerClient(side)).clientId)).requestId,
    }),
  }),
  oauth({
    name: "consent org switched off",
    method: "POST",
    path: (v) => `/api/v2/agent-access/authorize-requests/${v._req}/approve`,
    as: "bob",
    body: { org_ids: [orgs.b], consent_accepted: true },
    prepare: async (side) => ({
      _req: (await startAuthorize(side, (await registerClient(side)).clientId)).requestId,
    }),
  }),
  oauth({
    name: "consent validation",
    method: "POST",
    path: "/api/v2/agent-access/authorize-requests/whatever/approve",
    as: "alice",
    body: { org_ids: [] },
  }),

  // ── the dance ────────────────────────────────────────────────────────
  oauth({
    name: "dance then call mcp",
    method: "POST",
    path: "/api/mcp",
    body: WHOAMI,
    headers: (v) => MCP_HEADERS(String(v._access)),
    prepare: (side) => connect(side),
  }),
  oauth({
    name: "dance then call rest",
    method: "GET",
    path: "/api/v2/agent/whoami",
    headers: (v) => ({ authorization: `Bearer ${v._access}` }),
    prepare: (side) => connect(side),
  }),
  oauth({
    name: "dance confidential client",
    method: "POST",
    path: "/api/mcp",
    body: WHOAMI,
    headers: (v) => MCP_HEADERS(String(v._access)),
    prepare: (side) => connect(side, { token_endpoint_auth_method: "client_secret_post" }),
  }),
  oauth({
    name: "refresh rotates the pair",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      grant_type: "refresh_token",
      refresh_token: String(v._refresh),
      client_id: String(v._clientId),
    }),
    prepare: (side) => connect(side),
  }),
  oauth({
    name: "refresh narrows scope",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      grant_type: "refresh_token",
      refresh_token: String(v._refresh),
      client_id: String(v._clientId),
      scope: "read",
    }),
    prepare: (side) => connect(side),
  }),
  oauth({
    name: "refresh wider scope",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      grant_type: "refresh_token",
      refresh_token: String(v._refresh),
      client_id: String(v._clientId),
      scope: "read admin",
    }),
    prepare: (side) => connect(side),
  }),
  oauth({
    name: "old access token dies on refresh",
    method: "GET",
    path: "/api/v2/agent/whoami",
    headers: (v) => ({ authorization: `Bearer ${v._access}` }),
    prepare: async (side) => {
      const v = await connect(side);
      const r = await refresh(side, String(v._clientId), String(v._refresh));
      return { ...v, refreshed: { status: r.status, body: r.body } };
    },
  }),
  oauth({
    name: "refresh token replayed",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      grant_type: "refresh_token",
      refresh_token: String(v._refresh),
      client_id: String(v._clientId),
    }),
    prepare: async (side) => {
      const v = await connect(side);
      const r = await refresh(side, String(v._clientId), String(v._refresh));
      return { ...v, refreshed: { status: r.status, body: r.body } };
    },
    differs: "L-19: replaying a rotated refresh token revokes the grant and its live tokens",
  }),
  oauth({
    name: "refresh by another client",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      grant_type: "refresh_token",
      refresh_token: String(v._refresh),
      client_id: String(v._other),
    }),
    prepare: async (side) => {
      const v = await connect(side);
      const other = await registerClient(side);
      return { ...v, _other: other.clientId };
    },
  }),
  oauth({
    name: "revoke access token",
    method: "POST",
    path: "/api/mcp/revoke",
    urlencoded: (v) => ({
      token: String(v._access),
      client_id: String(v._clientId),
      client_secret: "",
    }),
    prepare: (side) => connect(side),
  }),
  oauth({
    name: "revoke refresh token by hint",
    method: "POST",
    path: "/api/mcp/revoke",
    urlencoded: (v) => ({
      token: String(v._refresh),
      token_type_hint: "refresh_token",
      client_id: String(v._clientId),
      client_secret: "",
    }),
    prepare: (side) => connect(side),
  }),
  oauth({
    name: "revoke without client_secret field",
    method: "POST",
    path: "/api/mcp/revoke",
    urlencoded: (v) => ({ token: String(v._access), client_id: String(v._clientId) }),
    prepare: (side) => connect(side),
  }),
  oauth({
    name: "revoke unknown token",
    method: "POST",
    path: "/api/mcp/revoke",
    urlencoded: (v) => ({
      token: "dbr_at_nope",
      client_id: String(v._clientId),
      client_secret: "",
    }),
    prepare: async (side) => ({ _clientId: (await registerClient(side)).clientId }),
  }),
  oauth({
    name: "revoked token is refused",
    method: "POST",
    path: "/api/mcp",
    body: WHOAMI,
    headers: (v) => MCP_HEADERS(String(v._access)),
    prepare: async (side) => {
      const v = await connect(side);
      const res = await side.fetch("/api/mcp/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: String(v._refresh),
          client_id: String(v._clientId),
          client_secret: "",
        }).toString(),
      });
      return { ...v, revoked: res.status };
    },
  }),

  // ── token endpoint refusals ──────────────────────────────────────────
  oauth({
    name: "token no client",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: { grant_type: "authorization_code" },
  }),
  oauth({
    name: "token unknown client",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: { client_id: "c0ffee00-0000-4000-8000-000000000000" },
  }),
  oauth({
    name: "token seeded client has no auth method",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: { client_id: agent.client, grant_type: "refresh_token" },
  }),
  oauth({
    name: "token no grant type",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({ client_id: String(v._clientId) }),
    prepare: async (side) => ({ _clientId: (await registerClient(side)).clientId }),
  }),
  oauth({
    name: "token unknown grant type",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({ client_id: String(v._clientId), grant_type: "password" }),
    prepare: async (side) => ({ _clientId: (await registerClient(side)).clientId }),
  }),
  oauth({
    name: "token missing fields",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      client_id: String(v._clientId),
      grant_type: "authorization_code",
      redirect_uri: "nope",
    }),
    prepare: async (side) => ({ _clientId: (await registerClient(side)).clientId }),
  }),
  oauth({
    name: "token jwt bearer",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      client_id: String(v._clientId),
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "x",
    }),
    prepare: async (side) => ({ _clientId: (await registerClient(side)).clientId }),
  }),
  oauth({
    name: "token unknown code",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      client_id: String(v._clientId),
      grant_type: "authorization_code",
      code: "nope",
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    }),
    prepare: async (side) => ({ _clientId: (await registerClient(side)).clientId }),
  }),
  oauth({
    name: "token wrong verifier",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      client_id: String(v._clientId),
      grant_type: "authorization_code",
      code: String(v._code),
      code_verifier: "wrong",
      redirect_uri: REDIRECT,
    }),
    prepare: async (side) => {
      const reg = await registerClient(side);
      const auth = await startAuthorize(side, reg.clientId);
      const consent = await approve(side, auth.requestId);
      return { _clientId: reg.clientId, _code: consent.code };
    },
  }),
  oauth({
    name: "token redirect mismatch",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      client_id: String(v._clientId),
      grant_type: "authorization_code",
      code: String(v._code),
      code_verifier: VERIFIER,
    }),
    prepare: async (side) => {
      const reg = await registerClient(side);
      const auth = await startAuthorize(side, reg.clientId);
      const consent = await approve(side, auth.requestId);
      return { _clientId: reg.clientId, _code: consent.code };
    },
  }),
  oauth({
    name: "token code used twice",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      client_id: String(v._clientId),
      grant_type: "authorization_code",
      code: String(v._code),
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    }),
    prepare: async (side) => {
      const v = await connect(side);
      return { first: v.token, _clientId: v._clientId, _code: v._code };
    },
  }),
  oauth({
    name: "token wrong secret",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      client_id: String(v._clientId),
      client_secret: "wrong",
      grant_type: "authorization_code",
      code: "x",
      code_verifier: VERIFIER,
    }),
    prepare: async (side) => ({
      _clientId: (await registerClient(side, { token_endpoint_auth_method: "client_secret_post" }))
        .clientId,
    }),
  }),
  oauth({
    name: "token basic auth",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      client_id: String(v._clientId),
      grant_type: "authorization_code",
      code: String(v._code),
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    }),
    headers: (v) => ({
      authorization: `Basic ${Buffer.from(`${v._clientId}:${v._secret}`).toString("base64")}`,
    }),
    prepare: async (side) => {
      const reg = await registerClient(side, { token_endpoint_auth_method: "client_secret_basic" });
      const auth = await startAuthorize(side, reg.clientId);
      const consent = await approve(side, auth.requestId);
      return {
        register: { status: reg.status, body: reg.body },
        _clientId: reg.clientId,
        _secret: reg.secret,
        _code: consent.code,
      };
    },
  }),

  // ── minted by the Python API, used against the side under test ───────
  // Every step of `prepare` runs against the old API; only the final request goes to the
  // side under test. Passing proves registered clients, grants and token pairs issued
  // before cutover keep working after it.
  oauth({
    name: "python-minted access token on mcp",
    method: "POST",
    path: "/api/mcp",
    body: WHOAMI,
    headers: (v) => MCP_HEADERS(String(v._access)),
    prepare: (_side, { old }) => connect(old),
  }),
  oauth({
    name: "python-minted access token on rest",
    method: "GET",
    path: "/api/v2/agent/projects/find",
    headers: (v) => ({ authorization: `Bearer ${v._access}` }),
    prepare: (_side, { old }) => connect(old),
  }),
  oauth({
    name: "python-minted refresh token rotates",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      grant_type: "refresh_token",
      refresh_token: String(v._refresh),
      client_id: String(v._clientId),
    }),
    prepare: (_side, { old }) => connect(old),
  }),
  oauth({
    name: "python-registered confidential client trades a code",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      grant_type: "authorization_code",
      code: String(v._code),
      client_id: String(v._clientId),
      client_secret: String(v._secret),
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    }),
    prepare: async (_side, { old }) => {
      // The code is parked where the Python server keeps it (Redis), so the code itself
      // is traded on the old side; the new side proves it reads the client the Python
      // server registered, secret included, on the refresh that follows.
      const reg = await registerClient(old, { token_endpoint_auth_method: "client_secret_post" });
      const auth = await startAuthorize(old, reg.clientId);
      const consent = await approve(old, auth.requestId);
      return { _clientId: reg.clientId, _secret: reg.secret, _code: consent.code };
    },
    differs:
      "codes are parked in Redis by the Python server and in Postgres by the platform; a code in flight at cutover is lost and the agent re-authorises",
  }),
  oauth({
    name: "python-registered confidential client refreshes",
    method: "POST",
    path: "/api/mcp/token",
    urlencoded: (v) => ({
      grant_type: "refresh_token",
      refresh_token: String(v._refresh),
      client_id: String(v._clientId),
      client_secret: String(v._secret),
    }),
    prepare: (_side, { old }) => connect(old, { token_endpoint_auth_method: "client_secret_post" }),
  }),
  oauth({
    name: "python-registered client revokes",
    method: "POST",
    path: "/api/mcp/revoke",
    urlencoded: (v) => ({
      token: String(v._access),
      client_id: String(v._clientId),
      client_secret: String(v._secret),
    }),
    prepare: (_side, { old }) => connect(old, { token_endpoint_auth_method: "client_secret_post" }),
  }),
  oauth({
    name: "python-registered client authorises",
    method: "GET",
    path: "/api/mcp/authorize",
    query: (v) => ({
      client_id: String(v._clientId),
      response_type: "code",
      code_challenge: CHALLENGE,
      redirect_uri: REDIRECT,
      state: "s",
      scope: "read",
    }),
    responseHeaders: ["location"],
    prepare: async (_side, { old }) => ({ _clientId: (await registerClient(old)).clientId }),
  }),
  oauth({
    name: "seeded grant from the template",
    method: "POST",
    path: "/api/mcp",
    body: WHOAMI,
    headers: (_v: Vars) => MCP_HEADERS(process.env.PARITY_AGENT_ACCESS_TOKEN ?? ""),
    setup: [...AGENT_GRANTS],
  }),
]);
