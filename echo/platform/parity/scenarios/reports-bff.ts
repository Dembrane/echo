import { projects } from "../fixtures";
import {
  METRICS,
  NEWER_CONVERSATION,
  P1_DRAFT,
  P2_OPEN,
  P2_REPORT,
  P3_REPORT,
} from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2, p3, legacy } = projects;
const R = "/api/v2/bff/reports";
const M = "/api/v2/bff/report-metrics";

const DELETED = "update project_report set deleted_at = now() where id = 1";
const CANVAS = `insert into project_report (project_id, status, language, kind, content, date_created, user_instructions)
  values ('${p1}', 'draft', 'en', 'canvas', '', now(), 'Live canvas')`;
const DETAILED = `update project_report set error_code = 'GENERATION_FAILED', error_message = 'boom',
  user_instructions = 'Focus on buses', scheduled_at = '2099-01-01T10:00:00Z', show_portal_link = true,
  date_created = '2026-09-01T09:30:00.123456Z', date_updated = '2026-09-02T09:30:00Z' where id = 1`;
const LEGACY_REPORT = `insert into project_report (project_id, status, language, kind, content, date_created)
  values ('${legacy}', 'published', 'en', 'report', '# Old', now())`;

export default scenarios([
  // ── GET /reports ──────────────────────────────────────────────────
  {
    name: "bff reports list: owner",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1 },
  },
  {
    name: "bff reports list: detailed row",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1 },
    setup: [DETAILED],
  },
  {
    name: "bff reports list: draft and canvas",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1 },
    setup: [P1_DRAFT, CANVAS],
  },
  {
    name: "bff reports list: deleted report left out",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1 },
    setup: [DELETED],
  },
  {
    name: "bff reports list: limit",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1, limit: "1" },
    setup: [P1_DRAFT],
  },
  {
    name: "bff reports list: limit zero",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1, limit: "0" },
  },
  {
    name: "bff reports list: limit too high",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1, limit: "1001" },
  },
  {
    name: "bff reports list: limit not a number",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1, limit: "many" },
  },
  { name: "bff reports list: project_id missing", as: "alice", method: "GET", path: R },
  {
    name: "bff reports list: flat fields",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1, fields: "id, status,content" },
  },
  {
    name: "bff reports list: relational field refused",
    as: "rita",
    method: "GET",
    path: R,
    query: { project_id: p2, fields: "id,project_id.name" },
    setup: [P2_OPEN, P2_REPORT],
    differs:
      "M-7: fields are an allowlist of the report's own columns; relational paths are refused",
  },
  {
    name: "bff reports list: observer",
    as: "rita",
    method: "GET",
    path: R,
    query: { project_id: p2 },
    setup: [P2_OPEN, P2_REPORT],
  },
  {
    name: "bff reports list: external",
    as: "bob",
    method: "GET",
    path: R,
    query: { project_id: p2 },
    setup: [P2_OPEN, P2_REPORT],
  },
  {
    name: "bff reports list: admin of the org",
    as: "erin",
    method: "GET",
    path: R,
    query: { project_id: p1 },
  },
  {
    name: "bff reports list: other tenant",
    as: "bob",
    method: "GET",
    path: R,
    query: { project_id: p1 },
  },
  {
    name: "bff reports list: own project of other org",
    as: "bob",
    method: "GET",
    path: R,
    query: { project_id: p3 },
    setup: [P3_REPORT],
  },
  {
    name: "bff reports list: staff without membership",
    as: "admin",
    method: "GET",
    path: R,
    query: { project_id: p3 },
  },
  {
    name: "bff reports list: not onboarded",
    as: "dave",
    method: "GET",
    path: R,
    query: { project_id: legacy },
    setup: [LEGACY_REPORT],
  },
  {
    name: "bff reports list: anonymous",
    as: "anonymous",
    method: "GET",
    path: R,
    query: { project_id: p1 },
  },
  {
    name: "bff reports list: missing project",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: "f0000000-0000-4000-8000-000000000099" },
  },
  {
    name: "bff reports list: project id not a uuid",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: "nope" },
  },

  // ── GET /reports/{id} ─────────────────────────────────────────────
  { name: "bff report: owner", as: "alice", method: "GET", path: `${R}/1` },
  {
    name: "bff report: detailed row",
    as: "alice",
    method: "GET",
    path: `${R}/1`,
    setup: [DETAILED],
  },
  {
    name: "bff report: without content",
    as: "alice",
    method: "GET",
    path: `${R}/1`,
    query: { include_content: "false" },
  },
  {
    name: "bff report: include_content not a boolean",
    as: "alice",
    method: "GET",
    path: `${R}/1`,
    query: { include_content: "maybe" },
  },
  {
    name: "bff report: canvas row",
    as: "alice",
    method: "GET",
    path: `${R}/2`,
    setup: [CANVAS],
  },
  { name: "bff report: missing", as: "alice", method: "GET", path: `${R}/99` },
  { name: "bff report: id not a number", as: "alice", method: "GET", path: `${R}/abc` },
  {
    name: "bff report: deleted",
    as: "alice",
    method: "GET",
    path: `${R}/1`,
    setup: [DELETED],
  },
  { name: "bff report: other tenant", as: "bob", method: "GET", path: `${R}/1` },
  {
    name: "bff report: observer",
    as: "rita",
    method: "GET",
    path: `${R}/2`,
    setup: [P2_OPEN, P2_REPORT],
  },
  { name: "bff report: anonymous", as: "anonymous", method: "GET", path: `${R}/1` },
  {
    name: "bff report: not onboarded",
    as: "dave",
    method: "GET",
    path: `${R}/2`,
    setup: [LEGACY_REPORT],
  },

  // ── GET /reports/{id}/timeline ────────────────────────────────────
  { name: "bff report timeline: owner", as: "alice", method: "GET", path: `${R}/1/timeline` },
  {
    name: "bff report timeline: siblings, metrics, conversations",
    as: "alice",
    method: "GET",
    path: `${R}/1/timeline`,
    setup: [P1_DRAFT, CANVAS, METRICS, NEWER_CONVERSATION, DETAILED],
  },
  {
    name: "bff report timeline: observer",
    as: "rita",
    method: "GET",
    path: `${R}/2/timeline`,
    setup: [P2_OPEN, P2_REPORT],
  },
  { name: "bff report timeline: other tenant", as: "bob", method: "GET", path: `${R}/1/timeline` },
  { name: "bff report timeline: missing", as: "alice", method: "GET", path: `${R}/99/timeline` },
  {
    name: "bff report timeline: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${R}/1/timeline`,
  },

  // ── GET /report-metrics ───────────────────────────────────────────
  {
    name: "bff metrics list: none",
    as: "alice",
    method: "GET",
    path: M,
    query: { report_id: "1" },
  },
  {
    name: "bff metrics list: two views",
    as: "alice",
    method: "GET",
    path: M,
    query: { report_id: "1" },
    setup: [METRICS],
  },
  { name: "bff metrics list: report_id missing", as: "alice", method: "GET", path: M },
  {
    name: "bff metrics list: other tenant",
    as: "bob",
    method: "GET",
    path: M,
    query: { report_id: "1" },
    setup: [METRICS],
  },
  {
    name: "bff metrics list: missing report",
    as: "alice",
    method: "GET",
    path: M,
    query: { report_id: "99" },
  },
  {
    name: "bff metrics list: anonymous",
    as: "anonymous",
    method: "GET",
    path: M,
    query: { report_id: "1" },
  },

  // ── POST /report-metrics ──────────────────────────────────────────
  {
    name: "bff metric create: owner",
    as: "alice",
    method: "POST",
    path: M,
    body: { project_report_id: "1", type: "view" },
  },
  {
    name: "bff metric create: with ip",
    as: "alice",
    method: "POST",
    path: M,
    body: { project_report_id: "1", type: "view", ip: "10.0.0.1" },
  },
  {
    name: "bff metric create: observer",
    as: "rita",
    method: "POST",
    path: M,
    body: { project_report_id: "2", type: "view" },
    setup: [P2_OPEN, P2_REPORT],
  },
  {
    name: "bff metric create: other tenant",
    as: "bob",
    method: "POST",
    path: M,
    body: { project_report_id: "1", type: "view" },
  },
  {
    name: "bff metric create: missing report",
    as: "alice",
    method: "POST",
    path: M,
    body: { project_report_id: "99", type: "view" },
  },
  {
    name: "bff metric create: type missing",
    as: "alice",
    method: "POST",
    path: M,
    body: { project_report_id: "1" },
  },
  {
    name: "bff metric create: report id as a number",
    as: "alice",
    method: "POST",
    path: M,
    body: { project_report_id: 1, type: "view" },
  },
  {
    name: "bff metric create: anonymous",
    as: "anonymous",
    method: "POST",
    path: M,
    body: { project_report_id: "1", type: "view" },
  },
]);
