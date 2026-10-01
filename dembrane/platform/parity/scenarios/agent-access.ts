// The dashboard side of agent access (/api/v2/agent-access/*): the server catalogue, the
// person's grants, the org switch with usage and per-org grants, and the audit trail, for
// each role that matters. The consent step itself is in mcp-oauth.ts.
import { AGENT_GRANTS, agentExtra, ORG_B_ON } from "../agent-setup";
import { agent, id, orgs, users } from "../fixtures";
import { type Scenario, scenarios } from "../runner/scenario";

const P = "/api/v2/agent-access";
const setup = [...AGENT_GRANTS];
const AUDIT = `insert into agent_audit_event
  (id, grant_id, app_user_id, client_id, org_id, tool, params, status, duration_ms, created_at) values
  ('${id("a7", 1)}', '${agent.grant}', '${users.alice.app}', '${agent.client}', '${orgs.a}', 'dembrane_get_project', '{"project_id": "p"}', 'ok', 12, '2026-09-03T09:00:00Z'),
  ('${id("a7", 2)}', '${agentExtra.grantErin}', '${users.erin.app}', '${agent.client}', '${orgs.a}', 'dembrane_whoami', '{}', 'ok', 3, '2026-09-03T10:00:00Z'),
  ('${id("a7", 3)}', '${agentExtra.grantBob}', '${users.bob.app}', '${agent.client}', '${orgs.b}', 'dembrane_find_projects', '{"query": ""}', 'denied', 5, '2026-09-03T11:00:00Z'),
  ('${id("a7", 4)}', '${agent.grant}', '${users.alice.app}', '${agent.client}', null, 'unknown_tool', '{"requested": "x", "arguments": []}', 'denied', 1, '2026-09-03T12:00:00Z')`;

const s = (
  name: string,
  as: Scenario["as"],
  method: Scenario["method"],
  path: string,
  extra: Partial<Scenario> = {},
): Scenario => ({
  name: `agent access: ${name}`,
  as,
  method,
  path,
  ...extra,
  setup: [...setup, ...((extra.setup as string[] | undefined) ?? [])],
});

export default scenarios([
  s("servers", "alice", "GET", `${P}/servers`),
  s("servers anonymous", "anonymous", "GET", `${P}/servers`),
  s("servers not onboarded", "dave", "GET", `${P}/servers`),
  s(
    "request expired",
    "alice",
    "GET",
    `${P}/authorize-requests/f0000000-0000-4000-8000-0000000000aa`,
  ),
  s("deny expired", "alice", "POST", `${P}/authorize-requests/nope/deny`),

  s("my grants", "alice", "GET", `${P}/grants`),
  s("my grants guest", "bob", "GET", `${P}/grants`),
  s("my grants none", "admin", "GET", `${P}/grants`),
  s("revoke my grant", "alice", "DELETE", `${P}/grants/${agentExtra.grantAliceRead}`),
  s("revoke someone else's grant", "alice", "DELETE", `${P}/grants/${agentExtra.grantBob}`),
  s("revoke missing grant", "alice", "DELETE", `${P}/grants/not-a-grant`),

  s("organisations owner", "alice", "GET", `${P}/organisations`),
  s("organisations guest", "bob", "GET", `${P}/organisations`),
  s("organisations observer", "rita", "GET", `${P}/organisations`),
  s("organisations member", "admin", "GET", `${P}/organisations`),
  s("switch off as owner", "alice", "PATCH", `${P}/organisations/${orgs.a}`, {
    body: { enabled: false },
  }),
  s("switch on as owner free org", "bob", "PATCH", `${P}/organisations/${orgs.b}`, {
    body: { enabled: true },
  }),
  s("switch as admin", "erin", "PATCH", `${P}/organisations/${orgs.a}`, {
    body: { enabled: true },
  }),
  s("switch as member", "admin", "PATCH", `${P}/organisations/${orgs.a}`, {
    body: { enabled: false },
  }),
  s("switch as outsider", "bob", "PATCH", `${P}/organisations/${orgs.a}`, {
    body: { enabled: false },
  }),
  s("switch bad body", "alice", "PATCH", `${P}/organisations/${orgs.a}`, {
    body: { enabled: "sometimes" },
  }),
  s("switch no body", "alice", "PATCH", `${P}/organisations/${orgs.a}`),

  s("org grants as owner", "alice", "GET", `${P}/organisations/${orgs.a}/grants`),
  s("org grants as admin", "erin", "GET", `${P}/organisations/${orgs.a}/grants`),
  s("org grants free org", "bob", "GET", `${P}/organisations/${orgs.b}/grants`, {
    setup: [ORG_B_ON],
  }),
  s("org grants as member", "admin", "GET", `${P}/organisations/${orgs.a}/grants`),
  s(
    "revoke org grant",
    "erin",
    "DELETE",
    `${P}/organisations/${orgs.a}/grants/${agentExtra.grantBob}`,
  ),
  s(
    "revoke grant of another org",
    "bob",
    "DELETE",
    `${P}/organisations/${orgs.b}/grants/${agentExtra.grantErin}`,
  ),
  s(
    "revoke org grant as guest",
    "rita",
    "DELETE",
    `${P}/organisations/${orgs.a}/grants/${agentExtra.grantBob}`,
  ),

  s("audit mine", "alice", "GET", `${P}/audit`, { setup: [AUDIT] }),
  s("audit mine paged", "alice", "GET", `${P}/audit`, {
    setup: [AUDIT],
    query: { limit: "1", offset: "1" },
  }),
  s("audit org as admin", "erin", "GET", `${P}/audit`, {
    setup: [AUDIT],
    query: { org_id: orgs.a },
  }),
  s("audit org as guest", "rita", "GET", `${P}/audit`, {
    setup: [AUDIT],
    query: { org_id: orgs.a },
  }),
  s("audit other org", "alice", "GET", `${P}/audit`, { setup: [AUDIT], query: { org_id: orgs.b } }),
  s("audit limit 501", "alice", "GET", `${P}/audit`, { query: { limit: "501" } }),
  s("audit not onboarded", "dave", "GET", `${P}/audit`),
]);
