// The REST face of agent access (/api/v2/agent/*): every route with the seeded grant and
// the extra grants of agent-setup.ts, the token refusals, validation, and the audit rows
// and tickets each call writes.
import { AGENT_GRANTS, bearer, ORG_A_OFF, ORG_B_ON, TOKENS } from "../agent-setup";
import { conversations, projects } from "../fixtures";
import { type Scenario, scenarios } from "../runner/scenario";

const { p1, p2, p3, legacy } = projects;
const { c1, c2, c3 } = conversations;
const A = "/api/v2/agent";
const MISSING = "f0000000-0000-4000-8000-00000000dead";
// Audit rows carry how long the call took.
const ignoreFields = ["duration_ms"];
// Erin's direct row in the default workspace as billing; it outranks her org admin role.
const ERIN_BILLING = `update workspace_membership set role = 'billing' where workspace_id = 'c0000000-0000-4000-8000-000000000001' and user_id = 'a0000000-0000-4000-8000-000000000004'`;
// Org B is free: a conversation of it stamped over the cap reads as locked.
const C3_LOCKED = `update conversation set is_over_cap = true where id = '${conversations.c3}'`;

type As = keyof typeof TOKENS;
function call(
  name: string,
  who: As | null,
  method: Scenario["method"],
  path: string,
  extra: Partial<Scenario> = {},
): Scenario {
  const setup = [...AGENT_GRANTS, ...((extra.setup as string[] | undefined) ?? [])];
  return {
    name: `agent rest: ${name}`,
    as: "anonymous",
    method,
    path,
    ignoreFields,
    ...extra,
    setup,
    ...(who && { headers: { ...bearer(TOKENS[who]), ...(extra.headers as object) } }),
  };
}

export default scenarios([
  // ── the token ────────────────────────────────────────────────────────
  call("no bearer", null, "GET", `${A}/whoami`),
  call("basic scheme", null, "GET", `${A}/whoami`, { headers: { authorization: "Basic abc" } }),
  call("unknown token", null, "GET", `${A}/whoami`, {
    headers: { authorization: "Bearer dbr_at_nope" },
  }),
  call("revoked grant", "revoked", "GET", `${A}/whoami`),
  call("expired grant", "expiredGrant", "GET", `${A}/whoami`),
  call("expired token", "expiredToken", "GET", `${A}/whoami`),
  call("lower-case scheme", null, "GET", `${A}/whoami`, {
    headers: { authorization: `bearer ${TOKENS.alice}` },
  }),
  {
    ...call("suspended person", "alice", "GET", `${A}/whoami`, {
      setup: [
        `update directus_users set status = 'suspended' where email = 'alice.parity@example.com'`,
      ],
    }),
    differs:
      "M-18: a suspended person's grants stop working; the Python API kept them until expiry",
  },

  // ── whoami and the catalogue ─────────────────────────────────────────
  call("whoami owner", "alice", "GET", `${A}/whoami`),
  call("whoami guest with org b off", "bob", "GET", `${A}/whoami`),
  call("whoami guest with org b on", "bob", "GET", `${A}/whoami`, { setup: [ORG_B_ON] }),
  call("whoami observer", "rita", "GET", `${A}/whoami`),
  call("whoami admin", "erin", "GET", `${A}/whoami`),
  call("whoami grant outside own orgs", "aliceOrgB", "GET", `${A}/whoami`),
  call("whoami org switched off", "alice", "GET", `${A}/whoami`, { setup: [ORG_A_OFF] }),
  call("tools", "alice", "GET", `${A}/tools`),

  // ── find projects ────────────────────────────────────────────────────
  call("find all", "alice", "GET", `${A}/projects/find`),
  call("find by word", "alice", "GET", `${A}/projects/find`, { query: { query: "city" } }),
  call("find every word any order", "alice", "GET", `${A}/projects/find`, {
    query: { query: " listening CITY " },
  }),
  call("find no match", "alice", "GET", `${A}/projects/find`, { query: { query: "zebra" } }),
  call("find in workspace", "alice", "GET", `${A}/projects/find`, {
    query: { workspace_id: "c0000000-0000-4000-8000-000000000002" },
  }),
  call("find limit 1", "alice", "GET", `${A}/projects/find`, { query: { limit: "1" } }),
  call("find limit 0", "alice", "GET", `${A}/projects/find`, { query: { limit: "0" } }),
  call("find limit 201", "alice", "GET", `${A}/projects/find`, { query: { limit: "201" } }),
  call("find limit text", "alice", "GET", `${A}/projects/find`, { query: { limit: "abc" } }),
  call("find guest", "bob", "GET", `${A}/projects/find`),
  call("find guest org b on", "bob", "GET", `${A}/projects/find`, { setup: [ORG_B_ON] }),
  call("find observer", "rita", "GET", `${A}/projects/find`),
  call("find org switched off", "alice", "GET", `${A}/projects/find`, { setup: [ORG_A_OFF] }),
  call("find bad token", null, "GET", `${A}/projects/find`, { query: { limit: "0" } }),

  // ── one project ──────────────────────────────────────────────────────
  call("project owner", "alice", "GET", `${A}/projects/${p1}`),
  call("project private as member", "alice", "GET", `${A}/projects/${p2}`),
  call("project other tenant", "alice", "GET", `${A}/projects/${p3}`),
  call("project legacy", "alice", "GET", `${A}/projects/${legacy}`),
  call("project missing", "alice", "GET", `${A}/projects/${MISSING}`),
  call("project org not in grant", "aliceOrgB", "GET", `${A}/projects/${p1}`),
  call("project org switched off", "alice", "GET", `${A}/projects/${p1}`, { setup: [ORG_A_OFF] }),
  call("project org b off", "bob", "GET", `${A}/projects/${p3}`),
  call("project org b on", "bob", "GET", `${A}/projects/${p3}`, { setup: [ORG_B_ON] }),
  call("project observer private", "rita", "GET", `${A}/projects/${p2}`),
  {
    ...call("project as workspace billing", "erin", "GET", `${A}/projects/${p1}`, {
      setup: [ERIN_BILLING],
    }),
    differs: "L-24: project settings need project:read, which a workspace billing role lacks",
  },

  // ── update ───────────────────────────────────────────────────────────
  call("update name", "alice", "PATCH", `${A}/projects/${p1}`, {
    body: { name: "Renamed by agent", is_conversation_allowed: false },
  }),
  call("update explicit null clears", "erin", "PATCH", `${A}/projects/${p1}`, {
    body: { context: null, default_conversation_title: "Hello" },
  }),
  call("update read-only grant", "aliceRead", "PATCH", `${A}/projects/${p1}`, {
    body: { name: "x" },
  }),
  call("update no fields", "alice", "PATCH", `${A}/projects/${p1}`, { body: {} }),
  call("update wrong type", "alice", "PATCH", `${A}/projects/${p1}`, { body: { name: 5 } }),
  call("update no body", "alice", "PATCH", `${A}/projects/${p1}`),
  call("update other tenant", "alice", "PATCH", `${A}/projects/${p3}`, { body: { name: "x" } }),
  call("update external on private", "bob", "PATCH", `${A}/projects/${p2}`, {
    body: { name: "x" },
  }),

  // ── webhooks ─────────────────────────────────────────────────────────
  call("webhooks owner", "alice", "GET", `${A}/projects/${p1}/webhooks`),
  call("webhooks admin", "erin", "GET", `${A}/projects/${p1}/webhooks`),
  call("webhooks free tier", "bob", "GET", `${A}/projects/${p3}/webhooks`, { setup: [ORG_B_ON] }),
  call("webhooks observer", "rita", "GET", `${A}/projects/${p2}/webhooks`),

  // ── conversations ────────────────────────────────────────────────────
  call("list", "alice", "GET", `${A}/projects/${p1}/conversations`),
  call("list detailed", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { format: "detailed" },
  }),
  call("list search", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { search: "resident CHARGING" },
  }),
  call("list sort duration", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { sort: "duration" },
  }),
  call("list page", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { limit: "1", offset: "1" },
  }),
  call("list has more", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { limit: "1" },
  }),
  call("list created bounds", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { created_after: "2026-09-01T09:30:00Z", created_before: "2026-09-02" },
  }),
  call("list bad bound", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { created_after: "yesterday" },
  }),
  call("list limit 501", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { limit: "501" },
  }),
  call("list bad sort", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { sort: "title" },
  }),
  call("list bad format", "alice", "GET", `${A}/projects/${p1}/conversations`, {
    query: { format: "full" },
  }),
  call("list locked", "bob", "GET", `${A}/projects/${p3}/conversations`, {
    query: { format: "detailed" },
    setup: [ORG_B_ON, C3_LOCKED],
  }),
  call("list other tenant", "alice", "GET", `${A}/projects/${p3}/conversations`),

  // ── transcript search ────────────────────────────────────────────────
  call("search", "alice", "GET", `${A}/projects/${p1}/search`, {
    query: { query: "charging buses" },
  }),
  call("search page", "alice", "GET", `${A}/projects/${p1}/search`, {
    query: { query: "charging cycle", limit: "1" },
  }),
  call("search short words", "alice", "GET", `${A}/projects/${p1}/search`, {
    query: { query: "the bus" },
  }),
  call("search blank", "alice", "GET", `${A}/projects/${p1}/search`, { query: { query: "   " } }),
  call("search empty", "alice", "GET", `${A}/projects/${p1}/search`, { query: { query: "" } }),
  call("search missing query", "alice", "GET", `${A}/projects/${p1}/search`),
  call("search limit 101", "alice", "GET", `${A}/projects/${p1}/search`, {
    query: { query: "charging", limit: "101" },
  }),
  call("search locked", "bob", "GET", `${A}/projects/${p3}/search`, {
    query: { query: "kickoff notes" },
    setup: [ORG_B_ON, C3_LOCKED],
  }),

  // ── one conversation ─────────────────────────────────────────────────
  call("conversation", "alice", "GET", `${A}/conversations/${c1}`),
  call("conversation live", "alice", "GET", `${A}/conversations/${c2}`),
  call("conversation other tenant", "alice", "GET", `${A}/conversations/${c3}`),
  call("conversation missing", "alice", "GET", `${A}/conversations/${MISSING}`),
  call("conversation locked", "bob", "GET", `${A}/conversations/${c3}`, {
    setup: [ORG_B_ON, C3_LOCKED],
  }),
  call("grep", "alice", "GET", `${A}/conversations/${c1}/grep`, { query: { query: "charging" } }),
  call("grep max 1", "alice", "GET", `${A}/conversations/${c1}/grep`, {
    query: { query: "charging buses grid", max_matches: "1" },
  }),
  call("grep short", "alice", "GET", `${A}/conversations/${c1}/grep`, { query: { query: "bus" } }),
  call("grep max 51", "alice", "GET", `${A}/conversations/${c1}/grep`, {
    query: { query: "charging", max_matches: "51" },
  }),
  call("grep locked", "bob", "GET", `${A}/conversations/${c3}/grep`, {
    query: { query: "kickoff" },
    setup: [ORG_B_ON, C3_LOCKED],
  }),
  call("transcript", "alice", "GET", `${A}/conversations/${c1}/transcript`),
  call("transcript detailed page", "alice", "GET", `${A}/conversations/${c1}/transcript`, {
    query: { format: "detailed", offset: "1", limit: "1" },
  }),
  call("transcript limit 201", "alice", "GET", `${A}/conversations/${c1}/transcript`, {
    query: { limit: "201" },
  }),
  call("transcript locked", "bob", "GET", `${A}/conversations/${c3}/transcript`, {
    setup: [ORG_B_ON, C3_LOCKED],
  }),
  call("transcript other tenant", "rita", "GET", `${A}/conversations/${c1}/transcript`),

  // ── docs ─────────────────────────────────────────────────────────────
  call("docs index", "alice", "GET", `${A}/docs/search`),
  call("docs grep", "alice", "GET", `${A}/docs/search`, {
    query: { pattern: "participant link", max_results: "5" },
  }),
  call("docs grep bad regex", "alice", "GET", `${A}/docs/search`, {
    query: { pattern: "(unclosed", max_results: "3" },
  }),
  call("docs max 51", "alice", "GET", `${A}/docs/search`, { query: { max_results: "51" } }),
  call("docs read", "alice", "GET", `${A}/docs/read`, {
    query: { path: "users/participant/index.md" },
  }),
  call("docs read page", "alice", "GET", `${A}/docs/read`, {
    query: { path: "/users/index.md", offset: "3", limit: "2" },
  }),
  call("docs read missing", "alice", "GET", `${A}/docs/read`, { query: { path: "nope.md" } }),
  call("docs read offset 0", "alice", "GET", `${A}/docs/read`, {
    query: { path: "users/index.md", offset: "0" },
  }),
  call("docs read no path", "alice", "GET", `${A}/docs/read`),

  // ── tickets ──────────────────────────────────────────────────────────
  call("issue", "alice", "POST", `${A}/issues`, {
    body: { message: "  The transcript is empty.  " },
  }),
  call("issue on project", "alice", "POST", `${A}/issues`, {
    body: { message: "Tags look off", project_id: p1 },
  }),
  call("issue on conversation", "alice", "POST", `${A}/issues`, {
    body: { message: "Broken audio", conversation_id: c1 },
  }),
  call("issue on both", "alice", "POST", `${A}/issues`, {
    body: { message: "Both named", project_id: p1, conversation_id: c1 },
  }),
  {
    ...call("issue on a foreign conversation", "alice", "POST", `${A}/issues`, {
      body: { message: "Look here", project_id: p1, conversation_id: c3 },
    }),
    differs: "L-24: a named conversation must be readable and belong to the named project",
  },
  call("issue other tenant project", "alice", "POST", `${A}/issues`, {
    body: { message: "x", project_id: p3 },
  }),
  call("issue blank", "alice", "POST", `${A}/issues`, { body: { message: "   " } }),
  call("issue empty", "alice", "POST", `${A}/issues`, { body: { message: "" } }),
  call("issue no body", "alice", "POST", `${A}/issues`),
  call("tool request", "alice", "POST", `${A}/tool-requests`, {
    body: { name: "  export_csv  ", description: "Export a project", example: "export_csv(p)" },
  }),
  call("tool request no example", "rita", "POST", `${A}/tool-requests`, {
    body: { name: "maps", description: "Show a map" },
  }),
  call("tool request blank", "alice", "POST", `${A}/tool-requests`, {
    body: { name: "x", description: "  " },
  }),
  call("tool request long name", "alice", "POST", `${A}/tool-requests`, {
    body: { name: "n".repeat(121), description: "d" },
  }),
]);
