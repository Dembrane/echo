import { createHmac } from "node:crypto";
import { conversations, id, projects } from "../fixtures";
import { scenarios } from "../runner/scenario";

const { p1, p2, p3, legacy } = projects;
const { c1, c2, c3 } = conversations;
const PING = (cid: string) => `/api/participant/conversations/${cid}/ping`;
const VISIT = (pid: string, vid: string) => `/api/participant/projects/${pid}/visitors/${vid}/ping`;
const B = "/api/v2/bff/conversations";

// A participant token as the new API issues it, signed with the parity AUTH_SECRET.
function token(conversationId: string, projectId: string): string {
  const key = createHmac("sha256", "parity-secret-parity-secret-parity-secret-00")
    .update("echo participant token v1")
    .digest();
  const body = Buffer.from(`${conversationId}.${projectId}`).toString("base64url");
  return `p1.${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

// Recent portal chunks, identical on both sides: two on c2 (one failed), one on c1, and a
// dashboard upload that the live views must ignore.
const RECENT = `
  insert into conversation_chunk (id, conversation_id, timestamp, source, transcript, error, detected_language, created_at, updated_at) values
  ('${id("c2", 101)}', '${c2}', now() - interval '20 seconds', 'PORTAL_AUDIO', 'Late buses again.', null, 'en', now(), now()),
  ('${id("c2", 102)}', '${c2}', now() - interval '10 seconds', 'PORTAL_AUDIO', null, 'Audio not playable', null, now(), now()),
  ('${id("c2", 103)}', '${c1}', now() - interval '100 seconds', 'PORTAL_AUDIO', null, null, null, now(), now()),
  ('${id("c2", 104)}', '${c2}', now() - interval '5 seconds', 'DASHBOARD_UPLOAD', 'upload', null, null, now(), now())`;
const RECENT_P3 = `
  insert into conversation_chunk (id, conversation_id, timestamp, source, transcript, created_at, updated_at) values
  ('${id("c2", 105)}', '${c3}', now() - interval '3 seconds', 'PORTAL_AUDIO', 'Org B live.', now(), now())`;

const q = (project_id: string, extra: Record<string, string> = {}) => ({ project_id, ...extra });

export default scenarios([
  // ── participant liveness ping ─────────────────────────────────────
  { name: "live ping: no body", as: "anonymous", method: "POST", path: PING(c2) },
  {
    name: "live ping: recording stamps recording_started_at",
    as: "anonymous",
    method: "POST",
    path: PING(c2),
    body: { project_id: p1, state: "recording", mode: "voice", audio_level: 0.42, client_ts: 1 },
  },
  {
    name: "live ping: an earlier stamp is kept",
    as: "anonymous",
    method: "POST",
    path: PING(c1),
    body: { project_id: p1, state: "recording" },
  },
  {
    name: "live ping: upload conversations are never stamped",
    as: "anonymous",
    method: "POST",
    path: PING(c2),
    setup: `update conversation set source = 'DASHBOARD_UPLOAD' where id = '${c2}'`,
    body: { state: "recording" },
  },
  {
    name: "live ping: full telemetry",
    as: "anonymous",
    method: "POST",
    path: PING(c2),
    body: {
      project_id: p1,
      state: "paused",
      mode: "voice",
      screen: "  record  ",
      visitor_id: "v-1",
      recorded_seconds: 12.345,
      segment_seconds: 3,
      network: { online: true, effective_type: "4g", downlink: 9.5, rtt: 50 },
      battery: { level: 0.8, charging: false },
    },
  },
  {
    name: "live ping: terminal state closes the meter",
    as: "anonymous",
    method: "POST",
    path: PING(c2),
    body: { project_id: p1, state: "left", client_ts: 5 },
  },
  {
    name: "live ping: text mode skips the meter",
    as: "anonymous",
    method: "POST",
    path: PING(c2),
    body: { project_id: p1, mode: "text", state: "text" },
  },
  {
    name: "live ping: unknown conversation id",
    as: "anonymous",
    method: "POST",
    path: PING("not-a-conversation"),
    body: { project_id: p1, state: "recording" },
  },
  {
    name: "live ping: absurd id",
    as: "anonymous",
    method: "POST",
    path: PING("x".repeat(80)),
    body: { state: "recording" },
  },
  {
    name: "live ping: invalid telemetry",
    as: "anonymous",
    method: "POST",
    path: PING(c2),
    body: { audio_level: "loud", client_ts: 1.5, network: { rtt: "slow" } },
  },
  { name: "live ping: body is a list", as: "anonymous", method: "POST", path: PING(c2), body: [] },
  { name: "live ping: body is null", as: "anonymous", method: "POST", path: PING(c2), body: null },
  {
    name: "live ping: valid participant token",
    as: "anonymous",
    method: "POST",
    path: PING(c2),
    headers: { "x-participant-token": token(c2, p1) },
    body: { project_id: p1, state: "recording" },
  },
  {
    name: "live ping: wrong participant token",
    as: "anonymous",
    method: "POST",
    path: PING(c2),
    headers: { "x-participant-token": token(c3, p3) },
    body: { project_id: p1, state: "recording" },
    differs:
      "Q7: a ping with a wrong participant token still answers ok but is not trusted, so it stores and stamps nothing",
  },
  {
    name: "live ping: signed-in host",
    as: "alice",
    method: "POST",
    path: PING(c2),
    body: { project_id: p1, state: "waiting" },
  },

  // ── visitor funnel ping ───────────────────────────────────────────
  { name: "live visitor: no body", as: "anonymous", method: "POST", path: VISIT(p1, "visitor-1") },
  {
    name: "live visitor: telemetry",
    as: "anonymous",
    method: "POST",
    path: VISIT(p1, "visitor-1"),
    body: {
      stage: "terms",
      name: "  Ada  ",
      tags: ["energy", " ", "mobility"],
      tags_preselected: true,
      scan_count: 4000,
      device: "phone",
    },
  },
  {
    name: "live visitor: invalid body",
    as: "anonymous",
    method: "POST",
    path: VISIT(p1, "visitor-1"),
    body: { scan_count: "many", tags: "energy" },
  },
  {
    name: "live visitor: absurd id",
    as: "anonymous",
    method: "POST",
    path: VISIT(p1, "v".repeat(65)),
    body: { stage: "scanned" },
  },
  {
    name: "live visitor: unknown project",
    as: "anonymous",
    method: "POST",
    path: VISIT("not-a-project", "visitor-2"),
    body: { stage: "profile" },
  },

  // ── live-count ────────────────────────────────────────────────────
  {
    name: "live-count: removed",
    as: "alice",
    method: "GET",
    path: `${B}/live-count`,
    query: { project_id: p1 },
    removed: "its only caller, a dashboard card, was never mounted",
  },

  // ── live ──────────────────────────────────────────────────────────
  {
    name: "live list: owner",
    as: "alice",
    method: "GET",
    path: `${B}/live`,
    query: q(p1, { window_seconds: "120" }),
    setup: RECENT,
  },
  {
    name: "live list: other tenant owner",
    as: "bob",
    method: "GET",
    path: `${B}/live`,
    query: q(p3),
    setup: RECENT_P3,
  },
  { name: "live list: other tenant", as: "bob", method: "GET", path: `${B}/live`, query: q(p1) },
  { name: "live list: anonymous", as: "anonymous", method: "GET", path: `${B}/live`, query: q(p1) },
  {
    name: "live list: window too long",
    as: "alice",
    method: "GET",
    path: `${B}/live`,
    query: q(p1, { window_seconds: "601" }),
  },

  // ── monitor ───────────────────────────────────────────────────────
  {
    name: "monitor: owner with recent chunks",
    as: "alice",
    method: "GET",
    path: `${B}/monitor`,
    query: q(p1),
    setup: [
      RECENT,
      `insert into conversation_project_tag (conversation_id, project_tag_id) values ('${c2}', '${id("f2", 2)}')`,
    ],
  },
  {
    name: "monitor: idle project",
    as: "erin",
    method: "GET",
    path: `${B}/monitor`,
    query: q(p2, { window_seconds: "30" }),
  },
  {
    name: "monitor: other tenant owner",
    as: "bob",
    method: "GET",
    path: `${B}/monitor`,
    query: q(p3),
    setup: RECENT_P3,
  },
  {
    name: "monitor: free tier over its cap withholds transcripts",
    as: "bob",
    method: "GET",
    path: `${B}/monitor`,
    // Its own window: the 3 second snapshot cache outlives the database reset between scenarios.
    query: q(p3, { window_seconds: "46" }),
    setup: [
      RECENT_P3,
      `update billing_account set tier = 'free' where id = (select billing_account_id from workspace where id = (select workspace_id from project where id = '${p3}'))`,
      `update conversation set duration = 7200 where id = '${c3}'`,
    ],
  },
  { name: "monitor: other tenant", as: "bob", method: "GET", path: `${B}/monitor`, query: q(p1) },
  {
    name: "monitor: observer on a private project",
    as: "rita",
    method: "GET",
    path: `${B}/monitor`,
    query: q(p2),
  },
  {
    name: "monitor: not onboarded",
    as: "dave",
    method: "GET",
    path: `${B}/monitor`,
    query: q(legacy),
  },
  {
    name: "monitor: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${B}/monitor`,
    query: q(p1),
  },
  { name: "monitor: project required", as: "alice", method: "GET", path: `${B}/monitor` },
  {
    name: "monitor: window out of range",
    as: "alice",
    method: "GET",
    path: `${B}/monitor`,
    query: q(p1, { window_seconds: "0" }),
  },

  // ── monitor stream (refusals; the stream itself is covered by integration tests) ──
  {
    name: "monitor stream: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${B}/monitor/stream`,
    query: q(p1),
  },
  {
    name: "monitor stream: other tenant",
    as: "bob",
    method: "GET",
    path: `${B}/monitor/stream`,
    query: q(p1),
  },
  {
    name: "monitor stream: observer on a private project",
    as: "rita",
    method: "GET",
    path: `${B}/monitor/stream`,
    query: q(p2),
  },
  {
    name: "monitor stream: not onboarded",
    as: "dave",
    method: "GET",
    path: `${B}/monitor/stream`,
    query: q(legacy),
  },
  {
    name: "monitor stream: project required",
    as: "alice",
    method: "GET",
    path: `${B}/monitor/stream`,
  },
  {
    name: "monitor stream: window out of range",
    as: "alice",
    method: "GET",
    path: `${B}/monitor/stream`,
    query: q(p1, { window_seconds: "900" }),
  },

  // ── conversation health stream (refusals; the stream itself is covered by integration tests) ──
  {
    name: "health stream: no ids",
    as: "anonymous",
    method: "GET",
    path: "/api/conversations/health/stream",
  },
  {
    name: "health stream: blank ids",
    as: "anonymous",
    method: "GET",
    path: "/api/conversations/health/stream",
    query: { conversation_ids: " , ", project_ids: "" },
  },
  {
    name: "health stream: too many ids",
    as: "alice",
    method: "GET",
    path: "/api/conversations/health/stream",
    query: {
      conversation_ids: Array.from({ length: 15 }, (_, i) => `c${i}`).join(","),
      project_ids: Array.from({ length: 6 }, (_, i) => `p${i}`).join(","),
    },
  },
]);
