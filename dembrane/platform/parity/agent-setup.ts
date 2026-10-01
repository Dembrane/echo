// Agent grants and tokens beyond the seed's one, for the agent REST, MCP and agent-access
// scenarios. Raw tokens are fixed so both sides authenticate with the same string; only
// their SHA-256 is stored, as the OAuth server stores them.
import { createHash } from "node:crypto";
import { agent, conversations, id, orgs, projects, users } from "./fixtures";

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const FAR = "2099-01-01T00:00:00Z";
const T0 = "2026-09-01T09:00:00Z";

export const agentExtra = {
  grantAliceRead: id("ad", 2),
  grantBob: id("ad", 3),
  grantRita: id("ad", 4),
  grantErin: id("ad", 5),
  grantRevoked: id("ad", 6),
  grantExpired: id("ad", 7),
  grantAliceOrgB: id("ad", 8),
  confidentialClient: id("ac", 2),
} as const;
const x = agentExtra;

export const TOKENS = {
  alice: process.env.PARITY_AGENT_ACCESS_TOKEN ?? "",
  aliceRefresh: process.env.PARITY_AGENT_REFRESH_TOKEN ?? "",
  aliceRead: "dbr_at_parity-alice-read-only-0000000000000000000000",
  bob: "dbr_at_parity-bob-000000000000000000000000000000000000",
  rita: "dbr_at_parity-rita-00000000000000000000000000000000000",
  erin: "dbr_at_parity-erin-00000000000000000000000000000000000",
  revoked: "dbr_at_parity-revoked-grant-00000000000000000000000000",
  expiredGrant: "dbr_at_parity-expired-grant-00000000000000000000000000",
  expiredToken: "dbr_at_parity-expired-token-00000000000000000000000000",
  aliceOrgB: "dbr_at_parity-alice-org-b-0000000000000000000000000000",
  erinRefresh: "dbr_rt_parity-erin-refresh-000000000000000000000000000",
} as const;

const grant = (
  gid: string,
  user: { app: string | null; directus: string },
  orgIds: string[],
  scopes: string[],
  opts: { expires?: string; revoked?: string | null; client?: string } = {},
) => `insert into agent_grant (id, app_user_id, directus_user_id, client_id, client_name, org_ids, scopes,
    consent_accepted_at, consent_version, expires_at, revoked_at, last_used_at, created_at)
  values ('${gid}', '${user.app}', '${user.directus}', '${opts.client ?? agent.client}', 'Parity agent',
    '${JSON.stringify(orgIds)}', '${JSON.stringify(scopes)}', '${T0}', '2026-09-06',
    '${opts.expires ?? FAR}', ${opts.revoked ? `'${opts.revoked}'` : "null"}, null, '${T0}')`;

let tokenN = 10;
const token = (gid: string, raw: string, kind = "access", expires = FAR) =>
  `insert into agent_token (id, grant_id, kind, token_hash, pair_id, expires_at, revoked_at, created_at)
  values ('${id("ae", ++tokenN)}', '${gid}', '${kind}', '${sha(raw)}', '${id("af", tokenN)}', '${expires}', null, '${T0}')`;

/** Every extra grant with a live access token (and the expired and revoked ones). */
export const AGENT_GRANTS: readonly string[] = [
  grant(x.grantAliceRead, users.alice, [orgs.a], ["read"]),
  token(x.grantAliceRead, TOKENS.aliceRead),
  grant(x.grantBob, users.bob, [orgs.a, orgs.b], ["read", "write"]),
  token(x.grantBob, TOKENS.bob),
  grant(x.grantRita, users.rita, [orgs.a], ["read"]),
  token(x.grantRita, TOKENS.rita),
  grant(x.grantErin, users.erin, [orgs.a], ["read", "write"]),
  token(x.grantErin, TOKENS.erin),
  token(x.grantErin, TOKENS.erinRefresh, "refresh"),
  grant(x.grantRevoked, users.alice, [orgs.a], ["read"], { revoked: "2026-09-02T09:00:00Z" }),
  token(x.grantRevoked, TOKENS.revoked),
  grant(x.grantExpired, users.alice, [orgs.a], ["read"], { expires: "2026-09-02T09:00:00Z" }),
  token(x.grantExpired, TOKENS.expiredGrant),
  token(agent.grant, TOKENS.expiredToken, "access", "2026-09-02T09:00:00Z"),
  grant(x.grantAliceOrgB, users.alice, [orgs.b], ["read"]),
  token(x.grantAliceOrgB, TOKENS.aliceOrgB),
];

/** Org B switched on: a free org, so its calls count against the monthly budget. */
export const ORG_B_ON = `update org set agent_access_enabled = true where id = '${orgs.b}'`;
/** Org A switched off by its admin. */
export const ORG_A_OFF = `update org set agent_access_enabled = false where id = '${orgs.a}'`;

/**
 * A confidential client (client_secret_post) registered by the Python API before cutover:
 * its secret is stored Fernet-encrypted under the parity Directus SECRET.
 */
export function confidentialClient(encryptedSecret: string) {
  return `insert into agent_client (id, client_name, token_endpoint_auth_method, client_secret_encrypted,
      redirect_uris, metadata, created_at)
    values ('${x.confidentialClient}', 'Confidential agent', 'client_secret_post', '${encryptedSecret}',
      '["http://127.0.0.1:9/callback"]',
      '{"redirect_uris": ["http://127.0.0.1:9/callback"], "token_endpoint_auth_method": "client_secret_post", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "scope": "read write", "client_name": "Confidential agent", "client_id": "${x.confidentialClient}"}',
      '${T0}')`;
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
export { conversations, projects };
