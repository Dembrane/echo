// Smoke check of the parity stack through the Python API: every seeded user logs in through
// Directus and reads their own data back. Exits non-zero when an expectation fails.
//   bun legacy/parity/verify-old-api.ts          (API on :8100, see run-old-api.sh)
import { chats, conversations, orgs, projects, users, webhooks, workspaces } from "./fixtures";

const env = Object.fromEntries(
  (await Bun.file(new URL(".env.parity", import.meta.url)).text())
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const directus = process.env.PARITY_DIRECTUS_URL ?? "http://localhost:8065";
const api = process.env.PARITY_API_URL ?? "http://127.0.0.1:8100";
let failed = 0;

async function login(email: string): Promise<string> {
  const res = await fetch(`${directus}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: env.PARITY_USER_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`);
  return ((await res.json()) as { data: { access_token: string } }).data.access_token;
}

async function check(
  who: string,
  token: string,
  path: string,
  expect: (body: any) => boolean | string,
) {
  const res = await fetch(api + path, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null);
  const verdict = res.ok ? expect(body) : false;
  const ok = verdict !== false;
  if (!ok) failed++;
  const note = typeof verdict === "string" ? verdict : ok ? "" : JSON.stringify(body).slice(0, 160);
  console.log(`${ok ? "ok  " : "FAIL"} ${who.padEnd(6)} ${res.status} GET ${path} ${note}`);
}

const list = (b: any) =>
  Array.isArray(b) ? b : (b?.items ?? b?.data ?? b?.projects ?? b?.workspaces ?? b?.orgs ?? []);
const ids = (b: any) => list(b).map((x: any) => x.id);
const has = (b: any, ...want: string[]) =>
  want.every((w) => ids(b).includes(w)) && `ids ${ids(b).length}`;
const lacks = (b: any, ...not: string[]) => not.every((w) => !ids(b).includes(w));

const t: Record<string, string> = {};
for (const [k, u] of Object.entries(users)) t[k] = await login(u.email);
console.log(`logged in: ${Object.keys(t).join(", ")}`);

for (const k of ["admin", "alice", "bob", "erin", "rita"] as const) {
  await check(k, t[k]!, "/api/v2/me", (b) => b?.id === users[k].app);
}
await check(
  "alice",
  t.alice!,
  "/api/v2/orgs",
  (b) => has(b, orgs.a) && lacks(b, orgs.b) && "org A only",
);
await check(
  "bob",
  t.bob!,
  "/api/v2/orgs",
  (b) => has(b, orgs.b) && lacks(b, orgs.a) && "org B only",
);
await check("erin", t.erin!, "/api/v2/orgs", (b) => has(b, orgs.a) && "org A");
await check(
  "rita",
  t.rita!,
  "/api/v2/orgs",
  (b) => lacks(b, orgs.a, orgs.b) && `observer sees ${ids(b).length} orgs`,
);
await check("alice", t.alice!, "/api/v2/workspaces", (b) =>
  has(b, workspaces.aDefault, workspaces.aResearch),
);
await check("bob", t.bob!, "/api/v2/workspaces", (b) =>
  has(b, workspaces.bDefault, workspaces.aResearch),
);
await check(
  "rita",
  t.rita!,
  "/api/v2/workspaces",
  (b) => has(b, workspaces.aResearch) && lacks(b, workspaces.aDefault),
);
await check("alice", t.alice!, `/api/v2/workspaces/${workspaces.aDefault}/projects`, (b) =>
  has(b, projects.p1),
);
await check("erin", t.erin!, `/api/v2/workspaces/${workspaces.aResearch}/projects`, (b) =>
  has(b, projects.p2),
);
await check("bob", t.bob!, `/api/v2/workspaces/${workspaces.bDefault}/projects`, (b) =>
  has(b, projects.p3),
);
await check(
  "alice",
  t.alice!,
  `/api/v2/orgs/${orgs.a}/members`,
  (b) => `members ${list(b).length}`,
);
await check("alice", t.alice!, `/api/conversations/${conversations.c1}/transcript`, (b) =>
  JSON.stringify(b).includes("charging points") ? "transcript" : false,
);
await check("alice", t.alice!, `/api/projects/${projects.p1}/webhooks`, (b) => has(b, webhooks.p1));
await check(
  "alice",
  t.alice!,
  `/api/projects/${projects.p1}/reports`,
  (b) => `reports ${list(b).length}`,
);
await check("alice", t.alice!, `/api/verify/topics/${projects.p1}`, (b) =>
  JSON.stringify(b).includes("parity-local-priorities") ? "custom topic" : false,
);
await check("alice", t.alice!, `/api/agentic/projects/${projects.p1}/chats`, (b) =>
  JSON.stringify(b).includes(chats.p1) ? "chat" : `chats ${list(b).length}`,
);
await check("dave", t.dave!, "/api/v2/me", (b) => `legacy: ${JSON.stringify(b).slice(0, 80)}`);

// The seeded MCP grant: its access token authenticates as Alice on /api/mcp.
{
  const res = await fetch(`${api}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.PARITY_AGENT_ACCESS_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dembrane_whoami", arguments: {} },
    }),
  });
  const ok = res.ok && (await res.text()).includes(users.alice.app);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok  " : "FAIL"} agent  ${res.status} POST /api/mcp dembrane_whoami as alice`,
  );
}

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
