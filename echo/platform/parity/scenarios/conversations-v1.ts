// v1 /api/conversations reads and model-backed routes (counts, transcript, emails,
// token count, summarize, generate-title, get-reply).
import { conversations, id, projects, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

const { c1, c2, c3 } = conversations;
const C = (cid: string, tail: string) => `/api/conversations/${cid}/${tail}`;

// A workspace-visible project in org A's research workspace, so its observer (rita) and
// external (bob) reach a conversation; and a conversation in dave's legacy project.
const RESEARCH_PROJECT = id("f8", 1);
const RESEARCH_CONV = id("c5", 1);
const LEGACY_CONV = id("c5", 2);
const EMPTY_CONV = id("c5", 3);
const MISSING = id("c5", 9);

const RESEARCH = [
  `insert into project (id, name, language, workspace_id, directus_user_id, is_conversation_allowed, visibility, created_at, updated_at)
    values ('${RESEARCH_PROJECT}', 'Research open', 'nl', '${workspaces.aResearch}', '${users.erin.directus}', true, 'workspace', now(), now())`,
  `insert into conversation (id, project_id, participant_name, source, is_finished, created_at, updated_at)
    values ('${RESEARCH_CONV}', '${RESEARCH_PROJECT}', 'Onderzoek', 'PORTAL_AUDIO', true, now(), now())`,
  `insert into conversation_chunk (id, conversation_id, timestamp, transcript, source, created_at, updated_at)
    values ('${id("c6", 1)}', '${RESEARCH_CONV}', now(), 'Eerste stuk.', 'PORTAL_AUDIO', now(), now()),
           ('${id("c6", 2)}', '${RESEARCH_CONV}', now() + interval '1 minute', null, 'PORTAL_AUDIO', now(), now()),
           ('${id("c6", 3)}', '${RESEARCH_CONV}', now() + interval '2 minute', null, 'PORTAL_AUDIO', now(), now())`,
  `update conversation_chunk set error = 'Audio not playable' where id = '${id("c6", 3)}'`,
];
const LEGACY = `insert into conversation (id, project_id, participant_name, created_at, updated_at)
  values ('${LEGACY_CONV}', '${projects.legacy}', 'Old', now(), now())`;
const EMPTY_FINISHED = `insert into conversation (id, project_id, participant_name, is_finished, created_at, updated_at)
  values ('${EMPTY_CONV}', '${projects.p1}', 'Nothing said', true, now(), now())`;
const C1_DELETED = `update conversation set deleted_at = now() where id = '${c1}'`;
const EMAILS = `insert into project_report_notification_participants (id, project_id, email, email_opt_in, conversation_id)
  values ('${id("f9", 1)}', '${projects.p1}', 'one@example.com', true, '${c1}'),
         ('${id("f9", 2)}', '${projects.p1}', 'two@example.com', false, '${c1}'),
         ('${id("f9", 3)}', '${projects.p1}', null, true, '${c1}')`;
const C1_COUNTED = `update conversation set token_count = 1234 where id = '${c1}'`;
// Org B is on free: c3 over the cap is locked.
const C3_LOCKED = `update conversation set is_over_cap = true where id = '${c3}'`;
const P1_CLOSED = `update project set is_conversation_allowed = false where id = '${projects.p1}'`;

const GENERATED = ["summary", "title", "tag_ids"];

export default scenarios([
  // ── counts ───────────────────────────────────────────────────────
  { name: "conv v1 counts: owner", as: "alice", method: "GET", path: C(c1, "counts") },
  { name: "conv v1 counts: workspace admin", as: "erin", method: "GET", path: C(c1, "counts") },
  {
    name: "conv v1 counts: staff on another tenant",
    as: "admin",
    method: "GET",
    path: C(c3, "counts"),
  },
  { name: "conv v1 counts: other tenant", as: "bob", method: "GET", path: C(c1, "counts") },
  {
    name: "conv v1 counts: observer with pending and failed chunks",
    as: "rita",
    method: "GET",
    path: C(RESEARCH_CONV, "counts"),
    setup: RESEARCH,
  },
  {
    name: "conv v1 counts: external",
    as: "bob",
    method: "GET",
    path: C(RESEARCH_CONV, "counts"),
    setup: RESEARCH,
  },
  { name: "conv v1 counts: anonymous", as: "anonymous", method: "GET", path: C(c1, "counts") },
  { name: "conv v1 counts: missing", as: "alice", method: "GET", path: C(MISSING, "counts") },
  { name: "conv v1 counts: not a uuid", as: "alice", method: "GET", path: C("nope", "counts") },
  {
    name: "conv v1 counts: deleted",
    as: "alice",
    method: "GET",
    path: C(c1, "counts"),
    setup: C1_DELETED,
  },
  {
    name: "conv v1 counts: staff on a deleted one",
    as: "admin",
    method: "GET",
    path: C(c1, "counts"),
    setup: C1_DELETED,
  },
  {
    name: "conv v1 counts: legacy creator not onboarded",
    as: "dave",
    method: "GET",
    path: C(LEGACY_CONV, "counts"),
    setup: LEGACY,
  },
  {
    name: "conv v1 counts: not onboarded elsewhere",
    as: "dave",
    method: "GET",
    path: C(c1, "counts"),
  },

  // ── transcript ───────────────────────────────────────────────────
  { name: "conv v1 transcript: owner", as: "alice", method: "GET", path: C(c1, "transcript") },
  {
    name: "conv v1 transcript: text conversation",
    as: "erin",
    method: "GET",
    path: C(c2, "transcript"),
  },
  {
    name: "conv v1 transcript: observer skips untranscribed chunks",
    as: "rita",
    method: "GET",
    path: C(RESEARCH_CONV, "transcript"),
    setup: RESEARCH,
  },
  {
    name: "conv v1 transcript: no chunks",
    as: "alice",
    method: "GET",
    path: C(EMPTY_CONV, "transcript"),
    setup: EMPTY_FINISHED,
  },
  { name: "conv v1 transcript: other tenant", as: "bob", method: "GET", path: C(c1, "transcript") },
  {
    name: "conv v1 transcript: anonymous",
    as: "anonymous",
    method: "GET",
    path: C(c1, "transcript"),
  },

  // ── emails ───────────────────────────────────────────────────────
  {
    name: "conv v1 emails: owner",
    as: "alice",
    method: "GET",
    path: C(c1, "emails"),
    setup: EMAILS,
  },
  { name: "conv v1 emails: none", as: "alice", method: "GET", path: C(c2, "emails") },
  {
    name: "conv v1 emails: staff",
    as: "admin",
    method: "GET",
    path: C(c1, "emails"),
    setup: EMAILS,
  },
  {
    name: "conv v1 emails: other tenant",
    as: "bob",
    method: "GET",
    path: C(c1, "emails"),
    setup: EMAILS,
  },

  // ── token-count ──────────────────────────────────────────────────
  {
    name: "conv v1 token-count: computed and stored",
    as: "alice",
    method: "GET",
    path: C(c1, "token-count"),
  },
  {
    name: "conv v1 token-count: not stored while transcribing",
    as: "alice",
    method: "GET",
    path: C(c2, "token-count"),
  },
  {
    name: "conv v1 token-count: stored count wins",
    as: "erin",
    method: "GET",
    path: C(c1, "token-count"),
    setup: C1_COUNTED,
  },
  {
    name: "conv v1 token-count: observer",
    as: "rita",
    method: "GET",
    path: C(RESEARCH_CONV, "token-count"),
    setup: RESEARCH,
  },
  {
    name: "conv v1 token-count: other tenant",
    as: "bob",
    method: "GET",
    path: C(c1, "token-count"),
  },
  {
    name: "conv v1 token-count: anonymous",
    as: "anonymous",
    method: "GET",
    path: C(c1, "token-count"),
  },

  // ── summarize ────────────────────────────────────────────────────
  {
    name: "conv v1 summarize: owner",
    as: "alice",
    method: "POST",
    path: C(c1, "summarize"),
    ignoreFields: GENERATED,
  },
  {
    name: "conv v1 summarize: empty finished conversation",
    as: "alice",
    method: "POST",
    path: C(EMPTY_CONV, "summarize"),
    setup: EMPTY_FINISHED,
  },
  {
    name: "conv v1 summarize: observer refused",
    as: "rita",
    method: "POST",
    path: C(RESEARCH_CONV, "summarize"),
    setup: RESEARCH,
  },
  {
    name: "conv v1 summarize: locked on free",
    as: "bob",
    method: "POST",
    path: C(c3, "summarize"),
    setup: C3_LOCKED,
  },
  { name: "conv v1 summarize: other tenant", as: "bob", method: "POST", path: C(c1, "summarize") },
  {
    name: "conv v1 summarize: anonymous",
    as: "anonymous",
    method: "POST",
    path: C(c1, "summarize"),
  },
  {
    name: "conv v1 summarize: staff on a locked one",
    as: "admin",
    method: "POST",
    path: C(c3, "summarize"),
    setup: C3_LOCKED,
  },

  // ── generate-title ───────────────────────────────────────────────
  {
    name: "conv v1 generate-title: owner",
    as: "alice",
    method: "POST",
    path: C(c1, "generate-title"),
    ignoreFields: GENERATED,
  },
  {
    name: "conv v1 generate-title: no summary",
    as: "alice",
    method: "POST",
    path: C(c2, "generate-title"),
  },
  {
    name: "conv v1 generate-title: observer refused",
    as: "rita",
    method: "POST",
    path: C(RESEARCH_CONV, "generate-title"),
    setup: RESEARCH,
  },
  {
    name: "conv v1 generate-title: locked on free",
    as: "bob",
    method: "POST",
    path: C(c3, "generate-title"),
    setup: C3_LOCKED,
  },
  {
    name: "conv v1 generate-title: anonymous",
    as: "anonymous",
    method: "POST",
    path: C(c1, "generate-title"),
  },

  // ── get-reply (participant, streamed) ─────────────────────────────
  {
    name: "conv v1 get-reply: replies off streams the error",
    as: "anonymous",
    method: "POST",
    path: C(c1, "get-reply"),
    body: { language: "en" },
  },
  {
    name: "conv v1 get-reply: language required",
    as: "anonymous",
    method: "POST",
    path: C(c1, "get-reply"),
    body: {},
  },
  {
    name: "conv v1 get-reply: no body",
    as: "anonymous",
    method: "POST",
    path: C(c1, "get-reply"),
  },
  {
    name: "conv v1 get-reply: missing conversation",
    as: "anonymous",
    method: "POST",
    path: C(MISSING, "get-reply"),
    body: { language: "en" },
    differs:
      "H-10: a missing conversation answers 404 before streaming instead of a 200 error stream",
  },
  {
    name: "conv v1 get-reply: deleted conversation",
    as: "anonymous",
    method: "POST",
    path: C(c1, "get-reply"),
    body: { language: "en" },
    setup: C1_DELETED,
    differs: "H-10: a soft-deleted conversation is not replied to (404)",
  },
  {
    name: "conv v1 get-reply: project closed to participants",
    as: "anonymous",
    method: "POST",
    path: C(c1, "get-reply"),
    body: { language: "en" },
    setup: P1_CLOSED,
    differs: "H-10: replies need the project open for participation (403)",
  },
  {
    name: "conv v1 get-reply: wrong participant token",
    as: "anonymous",
    method: "POST",
    path: C(c1, "get-reply"),
    body: { language: "en" },
    headers: { "x-participant-token": "p1.bm9wZQ.bad" },
    differs: "Q7: a participant token that does not name this conversation is refused (403)",
  },
]);
