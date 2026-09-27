// Deterministic parity seed. Every row goes through Directus's admin REST API, the same
// path the Python API writes through, so Directus defaults, hooks and flows apply exactly
// as in production. IDs come from fixtures.ts; secrets from .env.parity.
import { createHash } from "node:crypto";
import {
  agent,
  billing,
  chats,
  conversations,
  id,
  orgs,
  projects,
  tags,
  users,
  verificationTopicKey,
  webhooks,
  workspaces,
} from "./fixtures";

const env = Object.fromEntries(
  (await Bun.file(new URL(".env.parity", import.meta.url)).text())
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = process.env.PARITY_DIRECTUS_URL ?? "http://localhost:8065";
const token = env.DIRECTUS_TOKEN;
const password = env.PARITY_USER_PASSWORD;
const accessRaw = env.PARITY_AGENT_ACCESS_TOKEN;
const refreshRaw = env.PARITY_AGENT_REFRESH_TOKEN;
if (!token || !password || !accessRaw || !refreshRaw)
  throw new Error(".env.parity is missing seed secrets: rerun bootstrap.sh");

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text).data : null;
}
const create = (collection: string, rows: unknown) => api("POST", `/items/${collection}`, rows);

const T0 = "2026-09-01T09:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Directus users. Roles come from directus-sync, which gives them fresh ids on a new
// database, so they are resolved by name.
const roles: Record<string, string> = {};
for (const r of await api("GET", "/roles?fields=id,name&limit=-1")) roles[r.name] = r.id;
await api(
  "POST",
  "/users",
  Object.values(users).map((u) => ({
    id: u.directus,
    email: u.email,
    password,
    first_name: u.first,
    last_name: u.last,
    role:
      roles[u.role] ??
      (() => {
        throw new Error(`role ${u.role} missing`);
      })(),
    status: "active",
  })),
);

// app_user rows, as create_app_user writes them at onboarding.
await create(
  "app_user",
  Object.values(users)
    .filter((u) => u.app)
    .map((u) => ({
      id: u.app,
      directus_user_id: u.directus,
      email: u.email,
      display_name: `${u.first} ${u.last}`,
      terms_accepted_at: T0,
      created_at: T0,
      updated_at: T0,
    })),
);

// Orgs, their billing accounts and workspaces, in onboarding's order: org, owner
// membership, org-scoped account, default workspace, workspace owner membership.
await create("org", [
  {
    id: orgs.a,
    name: "Parity Org A",
    created_by: users.alice.app,
    agent_access_enabled: true,
    agent_access_updated_at: T0,
    agent_access_updated_by: users.alice.app,
    created_at: T0,
    updated_at: T0,
  },
  { id: orgs.b, name: "Parity Org B", created_by: users.bob.app, created_at: T0, updated_at: T0 },
]);
await create("billing_account", [
  {
    id: billing.a,
    org_id: orgs.a,
    tier: "changemaker",
    payment_mode: "none",
    created_by: users.alice.app,
    created_at: T0,
    updated_at: T0,
  },
  {
    id: billing.b,
    org_id: orgs.b,
    tier: "free",
    payment_mode: "none",
    created_by: users.bob.app,
    created_at: T0,
    updated_at: T0,
  },
]);
await create("workspace", [
  {
    id: workspaces.aDefault,
    org_id: orgs.a,
    name: "Default",
    is_default: true,
    created_by: users.alice.app,
    billing_account_id: billing.a,
    created_at: T0,
    updated_at: T0,
  },
  {
    id: workspaces.aResearch,
    org_id: orgs.a,
    name: "Research",
    is_default: false,
    visibility: "private",
    created_by: users.erin.app,
    billing_account_id: billing.a,
    created_at: at(5),
    updated_at: at(5),
  },
  {
    id: workspaces.bDefault,
    org_id: orgs.b,
    name: "Default",
    is_default: true,
    created_by: users.bob.app,
    billing_account_id: billing.b,
    created_at: T0,
    updated_at: T0,
  },
]);

let n = 0;
const orgMem = (org: string, user: string, role: string) => ({
  id: id("e0", ++n),
  org_id: org,
  user_id: user,
  role,
  created_at: T0,
  updated_at: T0,
});
await create("org_membership", [
  orgMem(orgs.a, users.alice.app!, "owner"),
  orgMem(orgs.a, users.erin.app!, "admin"),
  orgMem(orgs.b, users.bob.app!, "owner"),
  orgMem(orgs.a, users.admin.app!, "member"),
]);
n = 0;
const wsMem = (ws: string, user: string, role: string) => ({
  id: id("e1", ++n),
  workspace_id: ws,
  user_id: user,
  role,
  source: "direct",
  created_at: T0,
  updated_at: T0,
});
await create("workspace_membership", [
  wsMem(workspaces.aDefault, users.alice.app!, "owner"),
  wsMem(workspaces.aDefault, users.erin.app!, "admin"),
  wsMem(workspaces.aDefault, users.admin.app!, "member"),
  wsMem(workspaces.aResearch, users.erin.app!, "owner"),
  wsMem(workspaces.aResearch, users.alice.app!, "member"),
  wsMem(workspaces.aResearch, users.bob.app!, "external"),
  wsMem(workspaces.aResearch, users.rita.app!, "observer"),
  wsMem(workspaces.bDefault, users.bob.app!, "owner"),
]);

// Projects, as POST /v2/workspaces/:id/projects writes them. The legacy project predates
// workspaces: owned through directus_user_id only.
await create("project", [
  {
    id: projects.p1,
    name: "City listening 2026",
    language: "en",
    workspace_id: workspaces.aDefault,
    directus_user_id: users.alice.directus,
    is_conversation_allowed: true,
    context: "Residents on energy and mobility.",
    is_verify_enabled: true,
    created_at: at(10),
    updated_at: at(10),
  },
  {
    id: projects.p2,
    name: "Research interviews",
    language: "nl",
    workspace_id: workspaces.aResearch,
    directus_user_id: users.erin.directus,
    is_conversation_allowed: true,
    visibility: "private",
    created_at: at(11),
    updated_at: at(11),
  },
  {
    id: projects.p3,
    name: "Org B kickoff",
    language: "en",
    workspace_id: workspaces.bDefault,
    directus_user_id: users.bob.directus,
    is_conversation_allowed: true,
    created_at: at(12),
    updated_at: at(12),
  },
  {
    id: projects.legacy,
    name: "Legacy project",
    language: "en",
    workspace_id: null,
    directus_user_id: users.dave.directus,
    is_conversation_allowed: true,
    created_at: at(1),
    updated_at: at(1),
  },
]);
await create("project_tag", [
  {
    id: tags.p1Energy,
    project_id: projects.p1,
    text: "energy",
    sort: 1,
    created_at: at(10),
    updated_at: at(10),
  },
  {
    id: tags.p1Mobility,
    project_id: projects.p1,
    text: "mobility",
    sort: 2,
    created_at: at(10),
    updated_at: at(10),
  },
]);

// Conversations with transcribed chunks.
const lines = [
  "We need more charging points near the flats, the waiting list is months long.",
  "Buses stop running at eleven, so people drive even when they would rather not.",
  "Heat pumps are fine but the grid connection took our street a year.",
];
await create("conversation", [
  {
    id: conversations.c1,
    project_id: projects.p1,
    participant_name: "Resident 1",
    participant_email: null,
    source: "PORTAL_AUDIO",
    title: "Charging and buses",
    summary: "Charging points are scarce; late buses are missing; grid connections are slow.",
    is_finished: true,
    is_all_chunks_transcribed: true,
    is_audio_processing_finished: true,
    duration: 312.5,
    merged_transcript: lines.join(" "),
    created_at: at(20),
    updated_at: at(30),
    recording_started_at: at(20),
  },
  {
    id: conversations.c2,
    project_id: projects.p1,
    participant_name: "Resident 2",
    source: "PORTAL_TEXT",
    is_finished: false,
    created_at: at(40),
    updated_at: at(41),
  },
  {
    id: conversations.c3,
    project_id: projects.p3,
    participant_name: "Kickoff",
    source: "PORTAL_AUDIO",
    is_finished: true,
    is_all_chunks_transcribed: true,
    is_audio_processing_finished: true,
    duration: 60,
    created_at: at(50),
    updated_at: at(55),
  },
]);
await create("conversation_chunk", [
  ...lines.map((t, i) => ({
    id: id("c2", i + 1),
    conversation_id: conversations.c1,
    timestamp: at(20 + i * 2),
    transcript: t,
    raw_transcript: t,
    source: "PORTAL_AUDIO",
    detected_language: "en",
    created_at: at(20 + i * 2),
    updated_at: at(21 + i * 2),
  })),
  {
    id: id("c2", 4),
    conversation_id: conversations.c2,
    timestamp: at(40),
    transcript: "Typed answer: the cycle lanes end abruptly at the ring road.",
    source: "PORTAL_TEXT",
    created_at: at(40),
    updated_at: at(40),
  },
  {
    id: id("c2", 5),
    conversation_id: conversations.c3,
    timestamp: at(50),
    transcript: "Kickoff notes for org B.",
    source: "PORTAL_AUDIO",
    detected_language: "en",
    created_at: at(50),
    updated_at: at(50),
  },
]);
await create("conversation_project_tag", [
  { conversation_id: conversations.c1, project_tag_id: tags.p1Energy },
]);

// A chat on project 1 with one exchange, scoped to conversation 1.
await create("project_chat", {
  id: chats.p1,
  project_id: projects.p1,
  name: "What do residents want?",
  chat_mode: "deep_dive",
  auto_select: false,
  user_created: users.alice.directus,
});
await create("project_chat_conversation", {
  project_chat_id: chats.p1,
  conversation_id: conversations.c1,
});
await create("project_chat_message", [
  {
    id: id("c4", 1),
    project_chat_id: chats.p1,
    message_from: "user",
    text: "What do residents want most?",
    tokens_count: 7,
  },
  {
    id: id("c4", 2),
    project_chat_id: chats.p1,
    message_from: "assistant",
    text: "More charging points and later buses.",
    tokens_count: 9,
  },
]);

// A published report.
await create("project_report", {
  project_id: projects.p1,
  status: "published",
  language: "en",
  kind: "report",
  content: "# City listening\n\nResidents ask for charging points and later buses.",
  user_created: users.alice.directus,
});

// A project-specific verification topic, as POST /verify/topics/:id/custom writes it, and
// the project's selection including it.
await create("verification_topic", {
  key: verificationTopicKey,
  prompt: "What are the local priorities?",
  icon: null,
  project_id: projects.p1,
  translations: { create: [{ languages_code: "en-US", label: "Local priorities" }] },
});
await api("PATCH", `/items/project/${projects.p1}`, {
  selected_verification_key_list: `agreements,gems,${verificationTopicKey}`,
});

// A webhook (org A is on changemaker, the tier webhooks need).
await create("project_webhook", {
  id: webhooks.p1,
  project_id: projects.p1,
  name: "Parity sink",
  url: "http://127.0.0.1:9/webhook",
  events: JSON.stringify(["conversation.transcribed", "report.generated"]),
  status: "published",
  secret: "parity-webhook-secret",
});

// An MCP agent grant for Alice on org A with a live access and refresh token, as the OAuth
// flow leaves them. The raw tokens are in .env.parity; expiry is far out so the template
// never ages out of validity.
await create("agent_client", {
  id: agent.client,
  client_name: "Parity agent",
  token_endpoint_auth_method: "none",
  client_secret_encrypted: null,
  redirect_uris: ["http://127.0.0.1:9/callback"],
  metadata: {},
  created_at: T0,
});
await create("agent_grant", {
  id: agent.grant,
  app_user_id: users.alice.app,
  directus_user_id: users.alice.directus,
  client_id: agent.client,
  client_name: "Parity agent",
  org_ids: [orgs.a],
  scopes: ["read", "write"],
  consent_accepted_at: T0,
  consent_version: "2026-09-06",
  expires_at: "2099-01-01T00:00:00.000Z",
  revoked_at: null,
  last_used_at: null,
  created_at: T0,
});
await create("agent_token", [
  {
    id: agent.access,
    grant_id: agent.grant,
    kind: "access",
    token_hash: sha256(accessRaw),
    pair_id: agent.pair,
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: T0,
  },
  {
    id: agent.refresh,
    grant_id: agent.grant,
    kind: "refresh",
    token_hash: sha256(refreshRaw),
    pair_id: agent.pair,
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: T0,
  },
]);

console.log(
  `seeded ${Object.keys(users).length} users, 2 orgs, 3 workspaces, 4 projects, 3 conversations, chat, report, topic, webhook, agent grant`,
);
