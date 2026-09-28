import { conversations, id, projects, tags } from "../fixtures";
import { EMPTY_PROJECT, extra, P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2, p3 } = projects;
const { c1, c2, c3 } = conversations;
const B = "/api/v2/bff/conversations";
const CH = "/api/v2/bff/conversation-chunks";
const TG = "/api/v2/bff/conversation-project-tags";
const chunk1 = id("c2", 1);
const cP2 = id("c1", 20);
const cRes = id("c1", 21);
const artifact = id("ca", 1);
const p2Tag = id("f2", 20);

/** A conversation in p2 (erin's private research project) with one transcribed chunk. */
const P2_CONVERSATION = [
  `insert into conversation (id, project_id, participant_name, source, is_finished, created_at, updated_at)
    values ('${cP2}', '${p2}', 'Interviewee', 'PORTAL_AUDIO', true, '2026-09-01T11:00:00Z', '2026-09-01T11:05:00Z')`,
  `insert into conversation_chunk (id, conversation_id, timestamp, transcript, source, created_at, updated_at)
    values ('${id("c2", 20)}', '${cP2}', '2026-09-01T11:00:00Z', 'Onderzoek begint.', 'PORTAL_AUDIO', '2026-09-01T11:00:00Z', '2026-09-01T11:00:00Z')`,
];
/** A second conversation in the research workspace that the observer and external can see. */
const RESEARCH_OPEN = [
  P2_OPEN,
  `insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
    values ('${cRes}', '${p2}', 'Open talk', 'PORTAL_TEXT', '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z')`,
];
const VERIFIED = `insert into conversation_artifact (id, conversation_id, key, topic_label, content, approved_at, date_created)
  values ('${artifact}', '${c1}', 'gems', 'Gems', 'Charging points', '2026-09-01T10:00:00Z', '2026-09-01T09:59:00Z')`;
const ERRORED_CHUNK = `insert into conversation_chunk (id, conversation_id, timestamp, error, source, created_at, updated_at)
  values ('${id("c2", 30)}', '${c2}', '2026-09-01T10:30:00Z', 'Audio not playable', 'PORTAL_AUDIO', '2026-09-01T10:30:00Z', '2026-09-01T10:30:00Z')`;
/** Org B is on free; c3 stamped over the cap is locked for its readers. */
const C3_LOCKED = `update conversation set is_over_cap = true where id = '${c3}'`;
/** Org B past its one free hour while c3 still records: the live gate locks it. */
const C3_LIVE_OVER_CAP = `update conversation set duration = 4000, is_finished = false where id = '${c3}'`;
const P2_TAG = `insert into project_tag (id, project_id, text, sort, created_at, updated_at)
  values ('${p2Tag}', '${p2}', 'research', 1, now(), now())`;

export default scenarios([
  // ── GET /api/v2/bff/conversations ─────────────────────────────────
  {
    name: "bff conversations list: owner",
    as: "alice",
    method: "GET",
    path: B,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations list: org admin",
    as: "erin",
    method: "GET",
    path: B,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations list: staff member",
    as: "admin",
    method: "GET",
    path: B,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations list: private project owner",
    as: "erin",
    method: "GET",
    path: B,
    query: { project_id: p2 },
    setup: P2_CONVERSATION,
  },
  {
    name: "bff conversations list: private project refused to member",
    as: "alice",
    method: "GET",
    path: B,
    query: { project_id: p2 },
    setup: P2_CONVERSATION,
  },
  {
    name: "bff conversations list: observer",
    as: "rita",
    method: "GET",
    path: B,
    query: { project_id: p2 },
    setup: RESEARCH_OPEN,
  },
  {
    name: "bff conversations list: external",
    as: "bob",
    method: "GET",
    path: B,
    query: { project_id: p2 },
    setup: RESEARCH_OPEN,
  },
  {
    name: "bff conversations list: other tenant",
    as: "bob",
    method: "GET",
    path: B,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations list: not onboarded",
    as: "dave",
    method: "GET",
    path: B,
    query: { project_id: projects.legacy },
  },
  {
    name: "bff conversations list: anonymous",
    as: "anonymous",
    method: "GET",
    path: B,
    query: { project_id: p1 },
  },
  { name: "bff conversations list: project required", as: "alice", method: "GET", path: B },
  {
    name: "bff conversations list: unknown project",
    as: "alice",
    method: "GET",
    path: B,
    query: { project_id: "nope" },
  },
  {
    name: "bff conversations list: bad paging and sort",
    as: "alice",
    method: "GET",
    path: B,
    query: { project_id: p1, limit: "0", offset: "-1", sort: "title", include_chunks: "maybe" },
  },
  {
    name: "bff conversations list: full rows with embeds",
    as: "alice",
    method: "GET",
    path: B,
    query: { project_id: p1, fields: "*", include_chunks: "true", include_tags: "true" },
    setup: [VERIFIED, ERRORED_CHUNK],
  },
  {
    name: "bff conversations list: chosen fields",
    as: "alice",
    method: "GET",
    path: B,
    query: { project_id: p1, fields: "title,summary,duration", sort: "duration" },
  },
  {
    name: "bff conversations list: relational fields refused",
    as: "alice",
    method: "GET",
    path: B,
    query: { project_id: p1, fields: "title,project_id.directus_user_id.email" },
    differs: "M-7: dotted field paths reached other collections through the admin client; now 400",
  },
  {
    name: "bff conversations list: filters",
    as: "alice",
    method: "GET",
    path: B,
    query: {
      project_id: p1,
      tag_ids: tags.p1Energy,
      verified_only: "true",
      search_text: "buses charging",
      sources: "PORTAL_AUDIO",
    },
    setup: [VERIFIED],
  },
  {
    name: "bff conversations list: search misses",
    as: "alice",
    method: "GET",
    path: B,
    query: { project_id: p1, search_text: "tram" },
  },
  {
    name: "bff conversations list: transcript required and paging",
    as: "alice",
    method: "GET",
    path: B,
    query: {
      project_id: p1,
      transcript_required: "true",
      limit: "1",
      offset: "1",
      sort: "created_at",
    },
  },
  {
    name: "bff conversations list: locked on free",
    as: "bob",
    method: "GET",
    path: B,
    query: { project_id: p3, include_chunks: "true", fields: "*" },
    setup: [C3_LOCKED],
  },
  {
    name: "bff conversations list: live over-cap gate",
    as: "bob",
    method: "GET",
    path: B,
    query: { project_id: p3 },
    setup: [C3_LIVE_OVER_CAP],
  },

  // ── GET /count ────────────────────────────────────────────────────
  {
    name: "bff conversations count: owner",
    as: "alice",
    method: "GET",
    path: `${B}/count`,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations count: filtered",
    as: "alice",
    method: "GET",
    path: `${B}/count`,
    query: { project_id: p1, tag_ids: tags.p1Energy, search_text: "Resident" },
  },
  {
    name: "bff conversations count: verified only",
    as: "alice",
    method: "GET",
    path: `${B}/count`,
    query: { project_id: p1, verified_only: "1" },
    setup: [VERIFIED],
  },
  {
    name: "bff conversations count: other tenant",
    as: "bob",
    method: "GET",
    path: `${B}/count`,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations count: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${B}/count`,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations count: project required",
    as: "alice",
    method: "GET",
    path: `${B}/count`,
  },

  // ── GET /remaining-count ──────────────────────────────────────────
  {
    name: "bff conversations remaining: owner",
    as: "alice",
    method: "GET",
    path: `${B}/remaining-count`,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations remaining: excluding the context",
    as: "alice",
    method: "GET",
    path: `${B}/remaining-count`,
    query: { project_id: p1, exclude_ids: c1 },
  },
  {
    name: "bff conversations remaining: other tenant",
    as: "bob",
    method: "GET",
    path: `${B}/remaining-count`,
    query: { project_id: p1 },
  },
  {
    name: "bff conversations remaining: observer",
    as: "rita",
    method: "GET",
    path: `${B}/remaining-count`,
    query: { project_id: p2 },
    setup: RESEARCH_OPEN,
  },

  // ── GET /{conversation_id} ────────────────────────────────────────
  { name: "bff conversation detail: owner", as: "alice", method: "GET", path: `${B}/${c1}` },
  {
    name: "bff conversation detail: embeds",
    as: "erin",
    method: "GET",
    path: `${B}/${c1}`,
    query: { include_chunks: "true", include_tags: "true" },
  },
  { name: "bff conversation detail: other tenant", as: "bob", method: "GET", path: `${B}/${c1}` },
  {
    name: "bff conversation detail: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${B}/${c1}`,
  },
  { name: "bff conversation detail: not onboarded", as: "dave", method: "GET", path: `${B}/${c1}` },
  {
    name: "bff conversation detail: missing",
    as: "alice",
    method: "GET",
    path: `${B}/${id("c1", 99)}`,
  },
  { name: "bff conversation detail: not a uuid", as: "alice", method: "GET", path: `${B}/abc` },
  {
    name: "bff conversation detail: deleted",
    as: "alice",
    method: "GET",
    path: `${B}/${c2}`,
    setup: `update conversation set deleted_at = now() where id = '${c2}'`,
  },
  {
    name: "bff conversation detail: observer",
    as: "rita",
    method: "GET",
    path: `${B}/${cRes}`,
    setup: RESEARCH_OPEN,
  },
  {
    name: "bff conversation detail: locked",
    as: "bob",
    method: "GET",
    path: `${B}/${c3}`,
    query: { include_chunks: "true" },
    setup: [C3_LOCKED],
  },

  // ── PATCH /{conversation_id} ──────────────────────────────────────
  {
    name: "bff conversation update: owner",
    as: "alice",
    method: "PATCH",
    path: `${B}/${c2}`,
    body: {
      title: "Cycle lanes",
      participant_name: "Resident two",
      is_finished: true,
      summary: null,
    },
  },
  {
    name: "bff conversation update: external may edit",
    as: "bob",
    method: "PATCH",
    path: `${B}/${cRes}`,
    body: { title: "Edited by external" },
    setup: RESEARCH_OPEN,
  },
  {
    name: "bff conversation update: observer refused",
    as: "rita",
    method: "PATCH",
    path: `${B}/${cRes}`,
    body: { title: "x" },
    setup: RESEARCH_OPEN,
  },
  {
    name: "bff conversation update: nothing to update",
    as: "alice",
    method: "PATCH",
    path: `${B}/${c2}`,
    body: {},
  },
  {
    name: "bff conversation update: internal fields ignored",
    as: "alice",
    method: "PATCH",
    path: `${B}/${c2}`,
    body: { project_id: p3, duration: 9 },
  },
  {
    name: "bff conversation update: validation",
    as: "alice",
    method: "PATCH",
    path: `${B}/${c2}`,
    body: { title: 5, is_finished: "sometimes" },
  },
  { name: "bff conversation update: no body", as: "alice", method: "PATCH", path: `${B}/${c2}` },
  {
    name: "bff conversation update: other tenant",
    as: "bob",
    method: "PATCH",
    path: `${B}/${c2}`,
    body: { title: "x" },
  },
  {
    name: "bff conversation update: anonymous",
    as: "anonymous",
    method: "PATCH",
    path: `${B}/${c2}`,
    body: { title: "x" },
  },

  // ── POST /{conversation_id}/move ──────────────────────────────────
  {
    name: "bff conversation move: owner",
    as: "alice",
    method: "POST",
    path: `${B}/${c1}/move`,
    body: { target_project_id: extra.project },
    setup: [EMPTY_PROJECT],
  },
  {
    name: "bff conversation move: into another workspace",
    as: "erin",
    method: "POST",
    path: `${B}/${c2}/move`,
    body: { target_project_id: p2 },
  },
  {
    name: "bff conversation move: target of another tenant",
    as: "alice",
    method: "POST",
    path: `${B}/${c1}/move`,
    body: { target_project_id: p3 },
  },
  {
    name: "bff conversation move: observer refused",
    as: "rita",
    method: "POST",
    path: `${B}/${cRes}/move`,
    body: { target_project_id: p2 },
    setup: RESEARCH_OPEN,
  },
  {
    name: "bff conversation move: validation",
    as: "alice",
    method: "POST",
    path: `${B}/${c1}/move`,
    body: {},
  },
  {
    name: "bff conversation move: anonymous",
    as: "anonymous",
    method: "POST",
    path: `${B}/${c1}/move`,
    body: { target_project_id: p2 },
  },

  // ── POST /bulk-move ───────────────────────────────────────────────
  {
    name: "bff conversations bulk move: removed",
    as: "alice",
    method: "POST",
    path: `${B}/bulk-move`,
    body: { conversation_ids: [c1], target_project_id: p2 },
    removed: "no client calls it; the dashboard and iOS move one conversation at a time",
  },

  // ── GET /{conversation_id}/chunks ─────────────────────────────────
  { name: "bff chunks list: owner", as: "alice", method: "GET", path: `${B}/${c1}/chunks` },
  {
    name: "bff chunks list: paged newest first",
    as: "alice",
    method: "GET",
    path: `${B}/${c1}/chunks`,
    query: { sort: "-timestamp", limit: "2", offset: "1" },
  },
  {
    name: "bff chunks list: chosen fields",
    as: "alice",
    method: "GET",
    path: `${B}/${c1}/chunks`,
    query: { fields: "id,transcript,detected_language" },
  },
  {
    name: "bff chunks list: relational fields refused",
    as: "alice",
    method: "GET",
    path: `${B}/${c1}/chunks`,
    query: { fields: "id,conversation_id.participant_email" },
    differs: "M-7: dotted field paths reached other collections through the admin client; now 400",
  },
  {
    name: "bff chunks list: locked",
    as: "bob",
    method: "GET",
    path: `${B}/${c3}/chunks`,
    setup: [C3_LOCKED],
  },
  {
    name: "bff chunks list: bad paging",
    as: "alice",
    method: "GET",
    path: `${B}/${c1}/chunks`,
    query: { limit: "5000", sort: "id" },
  },
  { name: "bff chunks list: other tenant", as: "bob", method: "GET", path: `${B}/${c1}/chunks` },
  { name: "bff chunks list: anonymous", as: "anonymous", method: "GET", path: `${B}/${c1}/chunks` },

  // ── GET /{conversation_id}/chunk-count ────────────────────────────
  { name: "bff chunk count: owner", as: "alice", method: "GET", path: `${B}/${c1}/chunk-count` },
  {
    name: "bff chunk count: transcript required",
    as: "alice",
    method: "GET",
    path: `${B}/${c2}/chunk-count`,
    query: { transcript_required: "true" },
    setup: [ERRORED_CHUNK],
  },
  {
    name: "bff chunk count: other tenant",
    as: "bob",
    method: "GET",
    path: `${B}/${c1}/chunk-count`,
  },
  {
    name: "bff chunk count: missing",
    as: "alice",
    method: "GET",
    path: `${B}/${id("c1", 99)}/chunk-count`,
  },

  // ── GET /api/v2/bff/conversation-chunks/{chunk_id} ────────────────
  {
    name: "bff chunk: removed",
    as: "alice",
    method: "GET",
    path: `${CH}/${chunk1}`,
    removed: "no client reads one chunk by id; chunks come through the conversation's chunk list",
  },

  // ── /api/v2/bff/conversation-project-tags ─────────────────────────
  {
    name: "bff conversation tags: owner",
    as: "alice",
    method: "GET",
    path: TG,
    query: { conversation_id: c1 },
  },
  {
    name: "bff conversation tags: none",
    as: "erin",
    method: "GET",
    path: TG,
    query: { conversation_id: c2 },
  },
  {
    name: "bff conversation tags: other tenant",
    as: "bob",
    method: "GET",
    path: TG,
    query: { conversation_id: c1 },
  },
  { name: "bff conversation tags: conversation required", as: "alice", method: "GET", path: TG },
  {
    name: "bff conversation tags: anonymous",
    as: "anonymous",
    method: "GET",
    path: TG,
    query: { conversation_id: c1 },
  },
  {
    name: "bff conversation tags replace: swap",
    as: "alice",
    method: "POST",
    path: `${TG}/replace`,
    body: { conversation_id: c1, project_tag_ids: [tags.p1Mobility] },
  },
  {
    name: "bff conversation tags replace: keep and ignore foreign",
    as: "alice",
    method: "POST",
    path: `${TG}/replace`,
    body: { conversation_id: c1, project_tag_ids: [tags.p1Energy, p2Tag, "", "junk"] },
    setup: [P2_TAG],
  },
  {
    name: "bff conversation tags replace: clear",
    as: "erin",
    method: "POST",
    path: `${TG}/replace`,
    body: { conversation_id: c1, project_tag_ids: [] },
  },
  {
    name: "bff conversation tags replace: observer refused",
    as: "rita",
    method: "POST",
    path: `${TG}/replace`,
    body: { conversation_id: cRes, project_tag_ids: [] },
    setup: RESEARCH_OPEN,
  },
  {
    name: "bff conversation tags replace: other tenant",
    as: "bob",
    method: "POST",
    path: `${TG}/replace`,
    body: { conversation_id: c1, project_tag_ids: [] },
  },
  {
    name: "bff conversation tags replace: validation",
    as: "alice",
    method: "POST",
    path: `${TG}/replace`,
    body: { conversation_id: c1, project_tag_ids: "energy" },
  },
]);
