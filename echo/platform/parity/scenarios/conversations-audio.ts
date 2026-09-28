import { conversations, id, projects } from "../fixtures";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

// v1 conversation routes that touch audio (dembrane/api/conversation.py): play, play a
// chunk, retranscribe, delete. The parity stack has no bucket, so merges fail on both
// sides alike; the success paths are in packages/conversations/test/portal.integration.test.ts.
const { c1, c2, c3 } = conversations;
const C = "/api/conversations";
const P2_CONV = id("c1", 20);
const IN_P2 = [
  P2_OPEN,
  `insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
    values ('${P2_CONV}', '${projects.p2}', 'Interview 1', 'PORTAL_AUDIO', now(), now())`,
];
const MERGED = `update conversation set merged_audio_path = 'http://127.0.0.1:9/parity/audio-conversations/merged-c1-x.mp3' where id = '${c1}'`;
const CHUNK_AUDIO = `update conversation_chunk set path = 'http://127.0.0.1:9/parity/conversation/${c1}/chunks/x-a.mp3' where id = '${id("c2", 1)}'`;

export default scenarios([
  // ── content ──────────────────────────────────────────────────────
  {
    name: "audio content: owner, no audio yet",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/content`,
  },
  {
    name: "audio content: staff",
    as: "admin",
    method: "GET",
    path: `${C}/${c3}/content`,
    differs: "H-14: staff reach a tenant's conversations only through a support session",
  },
  {
    name: "audio content: stored merged file as a plain url",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/content`,
    query: { return_url: "true", signed: "false" },
    setup: MERGED,
  },
  {
    name: "audio content: forced merge fails without a bucket",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/content`,
    query: { force_merge: "true", return_url: "true" },
    setup: [MERGED, CHUNK_AUDIO],
    // The storage client's error text is part of the detail (boto versus Bun's client).
    ignoreFields: ["detail"],
  },
  {
    name: "audio content: conversation without chunks",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/content`,
    setup: `delete from conversation_chunk where conversation_id = '${c1}'`,
  },
  {
    name: "audio content: observer in the research workspace",
    as: "rita",
    method: "GET",
    path: `${C}/${P2_CONV}/content`,
    setup: IN_P2,
  },
  { name: "audio content: other tenant", as: "bob", method: "GET", path: `${C}/${c1}/content` },
  { name: "audio content: not onboarded", as: "dave", method: "GET", path: `${C}/${c1}/content` },
  { name: "audio content: anonymous", as: "anonymous", method: "GET", path: `${C}/${c1}/content` },
  {
    name: "audio content: unknown",
    as: "alice",
    method: "GET",
    path: `${C}/${id("c1", 99)}/content`,
  },
  { name: "audio content: not a uuid", as: "alice", method: "GET", path: `${C}/nope/content` },
  {
    name: "audio content: deleted",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/content`,
    setup: `update conversation set deleted_at = now() where id = '${c1}'`,
  },
  {
    name: "audio content: validation",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/content`,
    query: { force_merge: "maybe" },
  },

  // ── one chunk ────────────────────────────────────────────────────
  {
    name: "audio chunk: no audio on a typed chunk",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/chunks/${id("c2", 1)}/content`,
  },
  {
    name: "audio chunk: a stored path as a plain url",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/chunks/${id("c2", 1)}/content`,
    query: { return_url: "true", signed: "false" },
    setup: CHUNK_AUDIO,
  },
  {
    name: "audio chunk: a path that is not a url",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/chunks/${id("c2", 1)}/content`,
    setup: `update conversation_chunk set path = 'local/x.mp3' where id = '${id("c2", 1)}'`,
  },
  {
    name: "audio chunk: chunk of another conversation",
    as: "alice",
    method: "GET",
    path: `${C}/${c1}/chunks/${id("c2", 5)}/content`,
  },
  {
    name: "audio chunk: other tenant",
    as: "bob",
    method: "GET",
    path: `${C}/${c1}/chunks/${id("c2", 1)}/content`,
  },

  // ── retranscribe (every refusal is a 200 with an error body, as before) ──
  {
    name: "retranscribe: owner, nothing to merge",
    as: "alice",
    method: "POST",
    path: `${C}/${c1}/retranscribe`,
    body: { new_conversation_name: "Again" },
  },
  {
    name: "retranscribe: staff, merge fails without a bucket",
    as: "admin",
    method: "POST",
    path: `${C}/${c1}/retranscribe`,
    body: { new_conversation_name: "", use_pii_redaction: true, attach_verified_artifacts: true },
    setup: CHUNK_AUDIO,
    ignoreFields: ["error_detail"],
  },
  {
    name: "retranscribe: observer lacks project:update",
    as: "rita",
    method: "POST",
    path: `${C}/${P2_CONV}/retranscribe`,
    body: { new_conversation_name: "x" },
    setup: IN_P2,
  },
  {
    name: "retranscribe: other tenant",
    as: "bob",
    method: "POST",
    path: `${C}/${c1}/retranscribe`,
    body: { new_conversation_name: "x" },
  },
  {
    name: "retranscribe: validation",
    as: "alice",
    method: "POST",
    path: `${C}/${c1}/retranscribe`,
    body: { use_pii_redaction: "sometimes" },
  },
  {
    name: "retranscribe: anonymous",
    as: "anonymous",
    method: "POST",
    path: `${C}/${c1}/retranscribe`,
    body: { new_conversation_name: "x" },
  },

  // ── delete ───────────────────────────────────────────────────────
  { name: "delete conversation: owner", as: "alice", method: "DELETE", path: `${C}/${c2}` },
  { name: "delete conversation: org admin", as: "erin", method: "DELETE", path: `${C}/${c1}` },
  {
    name: "delete conversation: staff, other org",
    as: "admin",
    method: "DELETE",
    path: `${C}/${c3}`,
    differs: "H-14: staff no longer delete another tenant's conversation without a support session",
  },
  {
    name: "delete conversation: observer refused",
    as: "rita",
    method: "DELETE",
    path: `${C}/${P2_CONV}`,
    setup: IN_P2,
  },
  {
    name: "delete conversation: external refused",
    as: "bob",
    method: "DELETE",
    path: `${C}/${P2_CONV}`,
    setup: IN_P2,
  },
  { name: "delete conversation: other tenant", as: "bob", method: "DELETE", path: `${C}/${c1}` },
  { name: "delete conversation: not onboarded", as: "dave", method: "DELETE", path: `${C}/${c1}` },
  { name: "delete conversation: anonymous", as: "anonymous", method: "DELETE", path: `${C}/${c1}` },
  {
    name: "delete conversation: already deleted",
    as: "alice",
    method: "DELETE",
    path: `${C}/${c2}`,
    setup: `update conversation set deleted_at = now() where id = '${c2}'`,
  },
]);
