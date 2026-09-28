import { createHmac } from "node:crypto";
import { conversations, id, projects, tags } from "../fixtures";
import { scenarios } from "../runner/scenario";

// The participant portal core routes (dembrane/api/participant.py). No session: the old
// API takes the ids as the capability; the new one also takes a participant token.
const { p1, p3, legacy } = projects;
const { c1, c2, c3 } = conversations;
const P = "/api/participant";
const chunk = (n: number) => id("c2", n);
const CLOSE_P1 = `update project set is_conversation_allowed = false where id = '${p1}'`;
const MERGED_C1 = `update conversation set merged_audio_path = 'http://127.0.0.1:9/parity/audio-conversations/merged-c1.mp3' where id = '${c1}'`;
// A participant token as packages/conversations issues it, signed with the parity
// AUTH_SECRET the new API runs with; the old API ignores the header.
const KEY = createHmac("sha256", "parity-secret-parity-secret-parity-secret-00")
  .update("echo participant token v1")
  .digest();
const tokenFor = (conversationId: string, projectId: string) => {
  const body = Buffer.from(`${conversationId}.${projectId}`).toString("base64url");
  const sig = createHmac("sha256", KEY).update(body).digest("base64url");
  return { "x-participant-token": `p1.${body}.${sig}` };
};
const AT = "2026-09-27T10:00:00.000Z";
const fileUrl = (cid: string, chunkId: string) =>
  `http://127.0.0.1:9/parity/conversation/${cid}/chunks/${chunkId}-a.webm`;

export default scenarios([
  // ── initiate ─────────────────────────────────────────────────────
  {
    name: "portal initiate: open project",
    as: "anonymous",
    method: "POST",
    path: `${P}/projects/${p1}/conversations/initiate`,
    body: { name: "Resident 9", pin: "1234" },
  },
  {
    name: "portal initiate: email, agent, source and project tags",
    as: "anonymous",
    method: "POST",
    path: `${P}/projects/${p1}/conversations/initiate`,
    body: {
      name: "Resident 10",
      pin: "",
      email: "r10@example.com",
      user_agent: "Mozilla/5.0",
      source: "PORTAL_AUDIO",
      tag_id_list: [tags.p1Energy, tags.p1Mobility],
      visitor_id: "v-1",
    },
  },
  {
    name: "portal initiate: a tag of no project",
    as: "anonymous",
    method: "POST",
    path: `${P}/projects/${p1}/conversations/initiate`,
    body: { name: "R", pin: "1", tag_id_list: [id("ff", 1)] },
    differs:
      "L-6: the old API attached any tag id and failed with a 500 on a foreign key; tags outside the project are now dropped",
  },
  {
    name: "portal initiate: anonymised project",
    as: "anonymous",
    method: "POST",
    path: `${P}/projects/${p3}/conversations/initiate`,
    body: { name: "Kickoff 2", pin: "1", source: "PORTAL_TEXT" },
    setup: `update project set anonymize_transcripts = true where id = '${p3}'`,
  },
  {
    name: "portal initiate: closed project",
    as: "anonymous",
    method: "POST",
    path: `${P}/projects/${p1}/conversations/initiate`,
    body: { name: "R", pin: "1" },
    setup: CLOSE_P1,
  },
  {
    name: "portal initiate: validation",
    as: "anonymous",
    method: "POST",
    path: `${P}/projects/${p1}/conversations/initiate`,
    body: { name: 5, tag_id_list: "x" },
  },
  {
    name: "portal initiate: no body",
    as: "anonymous",
    method: "POST",
    path: `${P}/projects/${p1}/conversations/initiate`,
  },

  // ── project page ─────────────────────────────────────────────────
  { name: "portal project: open", as: "anonymous", method: "GET", path: `${P}/projects/${p1}` },
  {
    name: "portal project: other org",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p3}`,
  },
  {
    name: "portal project: legacy",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${legacy}`,
  },
  {
    name: "portal project: closed",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}`,
    setup: CLOSE_P1,
  },
  {
    name: "portal project: unknown",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${id("ff", 9)}`,
  },
  {
    name: "portal project: not a uuid",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/nope`,
  },
  {
    name: "portal project: deleted",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}`,
    setup: `update project set deleted_at = now() where id = '${p1}'`,
  },
  {
    name: "portal project: event invitation off on a paid tier",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}`,
    setup: `update project set is_dembrane_event_cta_enabled = false where id = '${p1}'`,
  },
  {
    name: "portal project: event invitation off on the free tier",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p3}`,
    setup: `update project set is_dembrane_event_cta_enabled = false where id = '${p3}'`,
  },
  {
    name: "portal project: workspace legal basis, logo and data owner",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}`,
    setup: `update workspace set legal_basis = 'consent', privacy_policy_url = 'https://example.com/privacy', logo_url = 'https://example.com/logo.png', data_owner_org_name = 'City of Parity' where id = '${"c0000000-0000-4000-8000-000000000001"}'`,
  },
  {
    name: "portal project: project override",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}`,
    setup: `update project set legal_basis = 'dembrane-events', default_conversation_title = 'Welcome', default_conversation_ask_for_participant_email = true where id = '${p1}'`,
  },

  // ── a participant's conversation ─────────────────────────────────
  {
    name: "portal conversation: own",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c1}`,
  },
  {
    name: "portal conversation: with a valid token",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c1}`,
    headers: tokenFor(c1, p1),
  },
  {
    name: "portal conversation: with another conversation's token",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c1}`,
    headers: tokenFor(c2, p1),
    differs: "Q7: a participant token that names another conversation is refused (403)",
  },
  {
    name: "portal conversation: another tenant's conversation through an open project",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c3}`,
    differs:
      "H-5: the old API did not bind the conversation to the project in the path; it now answers 404",
  },
  {
    name: "portal conversation: unknown",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${id("c1", 99)}`,
  },
  {
    name: "portal conversation: closed project",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c1}`,
    setup: CLOSE_P1,
  },
  {
    name: "portal conversation: deleted",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c1}`,
    setup: `update conversation set deleted_at = now() where id = '${c1}'`,
  },
  {
    name: "portal chunks: own, newest first",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c1}/chunks`,
  },
  {
    name: "portal chunks: another tenant's conversation",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c3}/chunks`,
    differs: "H-5: chunks of a conversation outside the project in the path are refused (404)",
  },
  {
    name: "portal chunks: closed project",
    as: "anonymous",
    method: "GET",
    path: `${P}/projects/${p1}/conversations/${c1}/chunks`,
    setup: CLOSE_P1,
  },

  // ── delete a chunk ───────────────────────────────────────────────
  {
    name: "portal chunk delete: own text chunk clears the token count",
    as: "anonymous",
    method: "DELETE",
    path: `${P}/projects/${p1}/conversations/${c2}/chunks/${chunk(4)}`,
    setup: `update conversation set token_count = 12 where id = '${c2}'`,
  },
  {
    name: "portal chunk delete: conversation outside the project",
    as: "anonymous",
    method: "DELETE",
    path: `${P}/projects/${p3}/conversations/${c1}/chunks/${chunk(1)}`,
  },
  {
    name: "portal chunk delete: another conversation's chunk",
    as: "anonymous",
    method: "DELETE",
    path: `${P}/projects/${p1}/conversations/${c1}/chunks/${chunk(5)}`,
    differs:
      "M-2: the old API deleted any chunk id once the conversation matched the project; the chunk must now belong to the conversation",
  },

  // ── typed text ───────────────────────────────────────────────────
  {
    name: "portal upload text: open conversation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/upload-text`,
    body: { timestamp: AT, content: "The square needs shade." },
    setup: `update conversation set token_count = 40 where id = '${c2}'`,
  },
  {
    name: "portal upload text: explicit source and offset timestamp",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/upload-text`,
    body: {
      timestamp: "2026-09-27T12:00:00+02:00",
      content: "More trees.",
      source: "PORTAL_TEXT_EDIT",
    },
  },
  {
    name: "portal upload text: finished and merged conversation is reopened",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c1}/upload-text`,
    body: { timestamp: AT, content: "One more thing." },
    setup: MERGED_C1,
  },
  {
    name: "portal upload text: blank content",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/upload-text`,
    body: { timestamp: AT, content: "   " },
  },
  {
    name: "portal upload text: closed project",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/upload-text`,
    body: { timestamp: AT, content: "x" },
    setup: CLOSE_P1,
  },
  {
    name: "portal upload text: unknown conversation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${id("c1", 99)}/upload-text`,
    body: { timestamp: AT, content: "x" },
  },
  {
    name: "portal upload text: validation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/upload-text`,
    body: { timestamp: "yesterday", content: 3 },
  },

  // ── audio through the API, pruned: the portal uploads with presigned URLs ──
  {
    name: "portal upload chunk: removed",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/upload-chunk`,
    form: { source: "PORTAL_AUDIO" },
    removed: "the legacy upload through the API; the portal and iOS use presigned uploads",
  },

  // ── presigned uploads ────────────────────────────────────────────
  {
    name: "portal check s3: open conversation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/check-s3`,
    // Signature material: the old API signs with SigV2 (no region), the platform with SigV4.
    ignoreFields: ["probe_url"],
  },
  {
    name: "portal check s3: closed project",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/check-s3`,
    setup: CLOSE_P1,
  },
  {
    name: "portal check s3: unknown conversation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${id("c1", 99)}/check-s3`,
  },
  {
    name: "portal upload url: open conversation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/get-upload-url`,
    body: { filename: "chunk-1.webm", content_type: "audio/webm", conversation_id: c2 },
    // The form's signature fields: SigV2 in the old API, SigV4 (what GCS HMAC keys need) now.
    ignoreFields: ["fields"],
  },
  {
    name: "portal upload url: closed project is a 500",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/get-upload-url`,
    body: { filename: "a.webm", content_type: "audio/webm", conversation_id: c2 },
    setup: CLOSE_P1,
  },
  {
    name: "portal upload url: unknown conversation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${id("c1", 99)}/get-upload-url`,
    body: { filename: "a.webm", content_type: "audio/webm", conversation_id: "x" },
  },
  {
    name: "portal upload url: traversal in the file name",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/get-upload-url`,
    body: { filename: "../../x.webm", content_type: "audio/webm", conversation_id: c2 },
  },
  {
    name: "portal upload url: validation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/get-upload-url`,
    body: { filename: "a.webm" },
  },
  {
    name: "portal confirm upload: object missing from the bucket",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/confirm-upload`,
    body: { chunk_id: id("c9", 1), file_url: fileUrl(c2, id("c9", 1)), timestamp: AT },
  },
  {
    name: "portal confirm upload: another conversation's key",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/confirm-upload`,
    body: { chunk_id: id("c9", 1), file_url: fileUrl(c3, id("c9", 1)), timestamp: AT },
    differs:
      "H-7: the old API accepted any key and would transcribe another conversation's audio into this one; keys must be the one issued for this conversation and chunk",
  },
  {
    name: "portal confirm upload: validation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/confirm-upload`,
    body: { chunk_id: 1, timestamp: "soon" },
  },

  // ── finish ───────────────────────────────────────────────────────
  {
    name: "portal finish: queues the finish",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/finish`,
  },
  {
    name: "portal finish: unknown conversation still answers OK",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${id("c1", 99)}/finish`,
  },
  {
    name: "portal finish: with a token for another conversation",
    as: "anonymous",
    method: "POST",
    path: `${P}/conversations/${c2}/finish`,
    headers: tokenFor(c1, p1),
    differs: "Q7/M-19: a participant token that names another conversation cannot finish this one",
  },
]);
