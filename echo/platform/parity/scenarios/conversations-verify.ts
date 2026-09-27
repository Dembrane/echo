import { conversations, id, projects, verificationTopicKey } from "../fixtures";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

// Verification topics (host settings) and artifacts (the portal's verify step). Seed: p1
// has verify on and one custom topic selected with two defaults; c1 is on p1, c3 on p3
// (verify off).
const { p1, p2, p3, legacy } = projects;
const { c1, c3 } = conversations;
const T = (p: string, tail = "") => `/api/verify/topics/${p}${tail}`;
const approved = id("fa", 1);
const draft = id("fa", 2);
const onC3 = id("fa", 3);
const ARTIFACTS = [
  `insert into conversation_artifact (id, conversation_id, key, topic_label, content, approved_at, date_created, read_aloud_stream_url)
    values ('${approved}', '${c1}', 'gems', 'Hidden gems', 'We found charging gems.', '2026-09-01T10:00:00Z', '2026-09-01T09:50:00Z', ''),
           ('${draft}', '${c1}', 'agreements', 'What we actually agreed on', 'Draft outcome', null, '2026-09-01T09:55:00Z', null),
           ('${onC3}', '${c3}', 'gems', 'Hidden gems', 'Kickoff gem', '2026-09-01T11:00:00Z', '2026-09-01T10:59:00Z', '')`,
];
// Directus stamped its service account into user_created and user_updated; the platform
// records the person who acted, or nobody for the portal. Those columns are the only
// intended difference in the rows. A custom topic's key ends in eight random characters.
const who = ["user_created", "user_updated"];
const randomKey = [
  ...who,
  "key",
  "verification_topic_key",
  "selected_verification_key_list",
  "selected_topics",
];
const P1_NO_SELECTION = `update project set selected_verification_key_list = null where id = '${p1}'`;
const RESEARCH_TOPIC = `insert into verification_topic (key, prompt, project_id, date_created) values ('research-x', 'Why?', '${p2}', now())`;

export default scenarios([
  // ── GET topics: public, the portal reads them by project id ──
  { name: "verify topics: portal read", as: "anonymous", method: "GET", path: T(p1) },
  { name: "verify topics: host read", as: "alice", method: "GET", path: T(p1) },
  {
    name: "verify topics: nothing selected means all",
    as: "anonymous",
    method: "GET",
    path: T(p1),
    setup: [P1_NO_SELECTION],
  },
  { name: "verify topics: another project", as: "anonymous", method: "GET", path: T(p3) },
  { name: "verify topics: missing project", as: "anonymous", method: "GET", path: T(id("f0", 99)) },
  { name: "verify topics: not a uuid", as: "anonymous", method: "GET", path: T("abc") },
  // ── PUT topics ──
  {
    name: "verify select: owner",
    as: "alice",
    method: "PUT",
    path: T(p1),
    body: { topic_list: ["gems", " truths ", "gems", "nope"] },
  },
  {
    name: "verify select: empty list clears",
    as: "alice",
    method: "PUT",
    path: T(p1),
    body: {},
  },
  {
    name: "verify select: validation",
    as: "alice",
    method: "PUT",
    path: T(p1),
    body: { topic_list: "gems" },
  },
  {
    name: "verify select: anonymous",
    as: "anonymous",
    method: "PUT",
    path: T(p1),
    body: { topic_list: ["gems"] },
    differs: "H-1: selecting topics needs a signed-in host with project:update",
  },
  {
    name: "verify select: other tenant",
    as: "bob",
    method: "PUT",
    path: T(p1),
    body: { topic_list: ["gems"] },
    differs: "H-1: selecting topics needs a signed-in host with project:update",
  },
  {
    name: "verify select: missing project",
    as: "alice",
    method: "PUT",
    path: T(id("f0", 99)),
    body: { topic_list: ["gems"] },
  },
  // ── custom topics ──
  {
    name: "verify custom create: owner",
    as: "alice",
    method: "POST",
    path: T(p1, "/custom"),
    body: {
      label: "Local Needs!",
      prompt: "What do people need nearby?",
      icon: "🏠",
      translations: { "nl-NL": " Lokale behoeften ", "de-DE": " ", "en-US": "ignored" },
    },
    ignoreFields: randomKey,
  },
  {
    name: "verify custom create: nothing selected keeps the selection empty",
    as: "erin",
    method: "POST",
    path: T(p1, "/custom"),
    body: { label: "Other", prompt: "P" },
    setup: [P1_NO_SELECTION],
    ignoreFields: randomKey,
  },
  {
    name: "verify custom create: validation",
    as: "alice",
    method: "POST",
    path: T(p1, "/custom"),
    body: { label: "x".repeat(101), icon: "12345678901", translations: { "nl-NL": 5 } },
  },
  {
    name: "verify custom create: anonymous",
    as: "anonymous",
    method: "POST",
    path: T(p1, "/custom"),
    body: { label: "a", prompt: "b" },
  },
  {
    name: "verify custom create: other tenant",
    as: "bob",
    method: "POST",
    path: T(p1, "/custom"),
    body: { label: "a", prompt: "b" },
  },
  {
    name: "verify custom create: never onboarded",
    as: "dave",
    method: "POST",
    path: T(p1, "/custom"),
    body: { label: "a", prompt: "b" },
  },
  {
    name: "verify custom create: missing project",
    as: "alice",
    method: "POST",
    path: T(id("f0", 99), "/custom"),
    body: { label: "a", prompt: "b" },
  },
  {
    name: "verify custom create: external on an open project",
    as: "bob",
    method: "POST",
    path: T(p2, "/custom"),
    body: { label: "Ext", prompt: "b" },
    setup: [P2_OPEN],
    ignoreFields: randomKey,
  },
  {
    name: "verify custom create: observer refused",
    as: "rita",
    method: "POST",
    path: T(p2, "/custom"),
    body: { label: "Obs", prompt: "b" },
    setup: [P2_OPEN],
    ignoreFields: randomKey,
    differs: "M-1: custom topics need project:update, which observers do not hold",
  },
  {
    name: "verify custom create: staff on another tenant",
    as: "admin",
    method: "POST",
    path: T(p3, "/custom"),
    body: { label: "Staff", prompt: "b" },
    ignoreFields: randomKey,
    differs: "H-14: staff act through their own workspace role, not a blanket bypass",
  },
  {
    name: "verify custom create: legacy creator",
    as: "dave",
    method: "POST",
    path: T(legacy, "/custom"),
    body: { label: "Legacy", prompt: "b" },
  },
  {
    name: "verify custom update: prompt and icon",
    as: "alice",
    method: "PATCH",
    path: T(p1, `/custom/${verificationTopicKey}`),
    body: { prompt: "What matters most here?", icon: "" },
    ignoreFields: who,
  },
  {
    name: "verify custom update: label with translations",
    as: "alice",
    method: "PATCH",
    path: T(p1, `/custom/${verificationTopicKey}`),
    body: { label: "Top priorities", translations: { "nl-NL": "Prioriteiten", "de-DE": "" } },
    ignoreFields: who,
  },
  {
    name: "verify custom update: label alone is ignored",
    as: "alice",
    method: "PATCH",
    path: T(p1, `/custom/${verificationTopicKey}`),
    body: { label: "Nope" },
    ignoreFields: who,
  },
  {
    name: "verify custom update: default topic is not custom",
    as: "alice",
    method: "PATCH",
    path: T(p1, "/custom/gems"),
    body: { prompt: "x" },
  },
  {
    name: "verify custom update: validation",
    as: "alice",
    method: "PATCH",
    path: T(p1, `/custom/${verificationTopicKey}`),
    body: { prompt: 5, translations: [] },
  },
  {
    name: "verify custom update: other tenant",
    as: "bob",
    method: "PATCH",
    path: T(p1, `/custom/${verificationTopicKey}`),
    body: { prompt: "x" },
  },
  {
    name: "verify custom delete: owner",
    as: "alice",
    method: "DELETE",
    path: T(p1, `/custom/${verificationTopicKey}`),
  },
  {
    name: "verify custom delete: nothing selected",
    as: "erin",
    method: "DELETE",
    path: T(p1, `/custom/${verificationTopicKey}`),
    setup: [P1_NO_SELECTION],
  },
  {
    name: "verify custom delete: topic of another project",
    as: "alice",
    method: "DELETE",
    path: T(p1, "/custom/research-x"),
    setup: [RESEARCH_TOPIC],
  },
  {
    name: "verify custom delete: anonymous",
    as: "anonymous",
    method: "DELETE",
    path: T(p1, `/custom/${verificationTopicKey}`),
  },
  // ── artifacts ──
  {
    name: "verify artifacts: approved only, newest first",
    as: "anonymous",
    method: "GET",
    path: `/api/verify/artifacts/${c1}`,
    setup: ARTIFACTS,
  },
  {
    name: "verify artifacts: none",
    as: "anonymous",
    method: "GET",
    path: `/api/verify/artifacts/${c1}`,
  },
  {
    name: "verify artifacts: missing conversation",
    as: "anonymous",
    method: "GET",
    path: `/api/verify/artifacts/${id("c1", 99)}`,
  },
  {
    name: "verify artifacts: not a uuid",
    as: "anonymous",
    method: "GET",
    path: "/api/verify/artifacts/abc",
  },
  {
    name: "verify artifact: detail",
    as: "anonymous",
    method: "GET",
    path: `/api/verify/artifact/${draft}`,
    setup: ARTIFACTS,
  },
  {
    name: "verify artifact: missing",
    as: "anonymous",
    method: "GET",
    path: `/api/verify/artifact/${draft}`,
  },
  {
    name: "verify artifact: blank id",
    as: "anonymous",
    method: "GET",
    path: "/api/verify/artifact/%20",
  },
  {
    name: "verify artifact: wrong participant token",
    as: "anonymous",
    method: "GET",
    path: `/api/verify/artifact/${draft}`,
    headers: { "x-participant-token": "p1.bogus.sig" },
    setup: ARTIFACTS,
    differs: "L-22/Q7: a participant token that does not name the conversation is refused",
  },
  // ── generate: the old API has no GCP_SA_JSON in parity and answers 500 before any
  // check, so only request validation compares; the rest is covered by verify tests ──
  {
    name: "verify generate: validation",
    as: "anonymous",
    method: "POST",
    path: "/api/verify/generate",
    body: { topic_list: "gems" },
  },
  {
    name: "verify generate: no body",
    as: "anonymous",
    method: "POST",
    path: "/api/verify/generate",
  },
  // ── update artifact ──
  {
    name: "verify artifact update: approve with content",
    as: "anonymous",
    method: "PUT",
    path: `/api/verify/artifact/${draft}`,
    body: { content: "Final outcome", approvedAt: "2026-09-02T10:00:00Z" },
    setup: ARTIFACTS,
    ignoreFields: who,
  },
  {
    name: "verify artifact update: field names accepted too",
    as: "anonymous",
    method: "PUT",
    path: `/api/verify/artifact/${draft}`,
    body: { content: "Edited", approved_at: "2026-09-02T10:00:00.123Z" },
    setup: ARTIFACTS,
    ignoreFields: who,
  },
  {
    name: "verify artifact update: approval alone is not an update",
    as: "anonymous",
    method: "PUT",
    path: `/api/verify/artifact/${draft}`,
    body: { approvedAt: "2026-09-02T10:00:00Z" },
    setup: ARTIFACTS,
  },
  {
    name: "verify artifact update: both refused",
    as: "anonymous",
    method: "PUT",
    path: `/api/verify/artifact/${draft}`,
    body: {
      content: "x",
      useConversation: { conversationId: c1, timestamp: "2026-09-01T00:00:00Z" },
    },
    setup: ARTIFACTS,
  },
  {
    name: "verify artifact update: validation",
    as: "anonymous",
    method: "PUT",
    path: `/api/verify/artifact/${draft}`,
    body: { useConversation: { timestamp: "nope" }, content: 5 },
  },
  {
    name: "verify artifact update: missing artifact",
    as: "anonymous",
    method: "PUT",
    path: `/api/verify/artifact/${draft}`,
    body: { content: "x" },
  },
  {
    name: "verify artifact update: project without verify",
    as: "anonymous",
    method: "PUT",
    path: `/api/verify/artifact/${onC3}`,
    body: { content: "x" },
    setup: ARTIFACTS,
    ignoreFields: who,
    differs: "H-2: artifacts change only on conversations whose project has verify on",
  },
  {
    name: "verify artifact update: deleted conversation",
    as: "anonymous",
    method: "PUT",
    path: `/api/verify/artifact/${draft}`,
    body: { content: "x" },
    setup: [...ARTIFACTS, `update conversation set deleted_at = now() where id = '${c1}'`],
    ignoreFields: who,
    differs: "H-2: a deleted conversation's artifacts no longer change",
  },
]);
