import { chats, id, projects, users } from "../fixtures";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2, p3, legacy } = projects;
// Fixed timestamps: setup runs once per side, and stream bodies carry event times verbatim.
const T = "2026-09-01T10:00:00.000Z";
const RUN = id("e0", 1); // alice's run on p1's chat, finished
const QUEUED = id("e0", 2); // alice's run on p1, a turn waiting to start
const ERIN_RUN = id("e0", 3); // erin's run on p1
const EMPTY_RUN = id("e0", 4); // alice's run with no user turn
const P3_CHAT = id("c3", 9);

const run = (rid: string, user: string, status: string, chat: string | null, lastSeq: number) =>
  `insert into project_agentic_run (id, project_id, project_chat_id, directus_user_id, status, last_event_seq, latest_output, created_at, updated_at, started_at, completed_at)
   values ('${rid}', '${p1}', ${chat ? `'${chat}'` : "null"}, '${user}', '${status}', ${lastSeq}, ${status === "completed" ? "'Answer one.'" : "null"}, '${T}', '${T}', ${status === "queued" ? "null" : `'${T}'`}, ${status === "completed" ? `'${T}'` : "null"})`;
const event = (rid: string, seq: number, type: string, payload: unknown) =>
  `insert into project_agentic_run_event (project_agentic_run_id, seq, event_type, payload, timestamp)
   values ('${rid}', ${seq}, '${type}', '${JSON.stringify(payload).replaceAll("'", "''")}'::json, '${T}')`;

const RUNS = [
  run(RUN, users.alice.directus, "completed", chats.p1, 2),
  event(RUN, 1, "user.message", { content: "q1", agent_prompt_content: "User Message: q1" }),
  event(RUN, 2, "assistant.message", { content: "Answer one." }),
  run(QUEUED, users.alice.directus, "queued", null, 1),
  event(QUEUED, 1, "user.message", { content: "q2" }),
  run(ERIN_RUN, users.erin.directus, "completed", null, 1),
  event(ERIN_RUN, 1, "user.message", { content: "mine" }),
  run(EMPTY_RUN, users.alice.directus, "queued", null, 0),
];
const P3_CHAT_ROW = `insert into project_chat (id, project_id, name, chat_mode, date_created) values ('${P3_CHAT}', '${p3}', 'Other', 'agentic', '${T}')`;

const R = "/api/agentic/runs";
const create = (body: unknown) => ({ method: "POST" as const, path: R, body });
const MISSING = id("e0", 99);

export default scenarios([
  // ── create ────────────────────────────────────────────────────────
  {
    name: "runs create: owner, no chat",
    as: "alice",
    ...create({ project_id: p1, message: "  What stands out?  " }),
  },
  {
    name: "runs create: in the chat, focus from its conversations",
    as: "alice",
    ...create({ project_id: p1, project_chat_id: chats.p1, message: "Summarise", language: "nl" }),
  },
  { name: "runs create: staff", as: "admin", ...create({ project_id: p1, message: "hi" }) },
  { name: "runs create: empty body", as: "alice", ...create({}) },
  { name: "runs create: blank message", as: "alice", ...create({ project_id: p1, message: "" }) },
  {
    name: "runs create: message too long",
    as: "alice",
    ...create({ project_id: p1, message: "x".repeat(32_001) }),
  },
  {
    name: "runs create: empty language",
    as: "alice",
    ...create({ project_id: p1, message: "x", language: "" }),
  },
  {
    name: "runs create: chat of another project",
    as: "alice",
    ...create({ project_id: p1, project_chat_id: P3_CHAT, message: "x" }),
    setup: [P3_CHAT_ROW],
  },
  {
    name: "runs create: chat that does not exist",
    as: "alice",
    ...create({ project_id: p1, project_chat_id: MISSING, message: "x" }),
  },
  {
    name: "runs create: unknown project",
    as: "alice",
    ...create({ project_id: MISSING, message: "x" }),
  },
  { name: "runs create: other tenant", as: "bob", ...create({ project_id: p1, message: "x" }) },
  {
    name: "runs create: observer",
    as: "rita",
    ...create({ project_id: p2, message: "x" }),
    setup: [P2_OPEN],
  },
  {
    name: "runs create: not onboarded",
    as: "dave",
    ...create({ project_id: legacy, message: "x" }),
  },
  { name: "runs create: anonymous", as: "anonymous", ...create({ project_id: p1, message: "x" }) },

  // ── follow-up messages ────────────────────────────────────────────
  {
    name: "runs message: finished run queues again",
    as: "alice",
    method: "POST",
    path: `${R}/${RUN}/messages`,
    body: { message: "And the second point?" },
    setup: RUNS,
  },
  {
    name: "runs message: someone else's run",
    as: "alice",
    method: "POST",
    path: `${R}/${ERIN_RUN}/messages`,
    body: { message: "x" },
    setup: RUNS,
  },
  {
    name: "runs message: unknown run",
    as: "alice",
    method: "POST",
    path: `${R}/${MISSING}/messages`,
    body: { message: "x" },
  },
  {
    name: "runs message: blank",
    as: "alice",
    method: "POST",
    path: `${R}/${RUN}/messages`,
    body: { message: "" },
    setup: RUNS,
  },

  // ── reads ─────────────────────────────────────────────────────────
  { name: "runs get: owner", as: "alice", method: "GET", path: `${R}/${RUN}`, setup: RUNS },
  { name: "runs get: staff", as: "admin", method: "GET", path: `${R}/${RUN}`, setup: RUNS },
  {
    name: "runs get: someone else's run",
    as: "bob",
    method: "GET",
    path: `${R}/${RUN}`,
    setup: RUNS,
  },
  { name: "runs get: unknown", as: "alice", method: "GET", path: `${R}/${MISSING}` },
  { name: "runs get: anonymous", as: "anonymous", method: "GET", path: `${R}/${RUN}`, setup: RUNS },
  {
    name: "runs latest: chat's run",
    as: "alice",
    method: "GET",
    path: `/api/agentic/chats/${chats.p1}/latest-run`,
    setup: RUNS,
  },
  {
    name: "runs latest: chat without runs",
    as: "alice",
    method: "GET",
    path: `/api/agentic/chats/${chats.p1}/latest-run`,
  },
  {
    name: "runs latest: someone else's",
    as: "erin",
    method: "GET",
    path: `/api/agentic/chats/${chats.p1}/latest-run`,
    setup: RUNS,
  },
  { name: "runs events: all", as: "alice", method: "GET", path: `${R}/${RUN}/events`, setup: RUNS },
  {
    name: "runs events: after a seq",
    as: "alice",
    method: "GET",
    path: `${R}/${RUN}/events`,
    query: { after_seq: "1" },
    setup: RUNS,
  },
  {
    name: "runs events: past the end",
    as: "alice",
    method: "GET",
    path: `${R}/${RUN}/events`,
    query: { after_seq: "5" },
    setup: RUNS,
  },
  {
    name: "runs events: negative seq",
    as: "alice",
    method: "GET",
    path: `${R}/${RUN}/events`,
    query: { after_seq: "-1" },
    setup: RUNS,
  },
  {
    name: "runs events: someone else's",
    as: "bob",
    method: "GET",
    path: `${R}/${RUN}/events`,
    setup: RUNS,
  },
  {
    name: "runs events: as a stream",
    as: "alice",
    method: "GET",
    path: `${R}/${RUN}/events`,
    headers: { accept: "text/event-stream" },
    setup: RUNS,
  },

  // ── stream of a finished run (a queued one needs the agent, which parity cannot run) ─
  {
    name: "runs stream: finished run replays and closes",
    as: "alice",
    method: "POST",
    path: `${R}/${RUN}/stream`,
    setup: RUNS,
  },
  {
    name: "runs stream: from a seq",
    as: "alice",
    method: "POST",
    path: `${R}/${RUN}/stream`,
    query: { after_seq: "1" },
    setup: RUNS,
  },
  {
    name: "runs stream: someone else's",
    as: "bob",
    method: "POST",
    path: `${R}/${RUN}/stream`,
    setup: RUNS,
  },
  { name: "runs stream: unknown", as: "alice", method: "POST", path: `${R}/${MISSING}/stream` },

  // ── stop ──────────────────────────────────────────────────────────
  {
    name: "runs stop: queued turn",
    as: "alice",
    method: "POST",
    path: `${R}/${QUEUED}/stop`,
    setup: RUNS,
  },
  {
    name: "runs stop: finished run",
    as: "alice",
    method: "POST",
    path: `${R}/${RUN}/stop`,
    setup: RUNS,
  },
  {
    name: "runs stop: no turn",
    as: "alice",
    method: "POST",
    path: `${R}/${EMPTY_RUN}/stop`,
    setup: RUNS,
  },
  {
    name: "runs stop: someone else's",
    as: "alice",
    method: "POST",
    path: `${R}/${ERIN_RUN}/stop`,
    setup: RUNS,
  },
]);
