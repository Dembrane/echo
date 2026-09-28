import { projects } from "../fixtures";
import { METRICS, NEWER_CONVERSATION, P1_DRAFT, P2_OPEN, P2_REPORT } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1 } = projects;
const R = "/api/v2/bff/reports";
const M = "/api/v2/bff/report-metrics";

const CANVAS = `insert into project_report (project_id, status, language, kind, content, date_created, user_instructions)
  values ('${p1}', 'draft', 'en', 'canvas', '', now(), 'Live canvas')`;
const DETAILED = `update project_report set error_code = 'GENERATION_FAILED', error_message = 'boom',
  user_instructions = 'Focus on buses', scheduled_at = '2099-01-01T10:00:00Z', show_portal_link = true,
  date_created = '2026-09-01T09:30:00.123456Z', date_updated = '2026-09-02T09:30:00Z' where id = 1`;

export default scenarios([
  // ── GET /reports ──────────────────────────────────────────────────
  {
    name: "bff reports list: removed",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1 },
    removed: "no client calls it; the dashboard reads reports through /api/projects/{id}/reports",
  },

  // ── GET /reports/{id} ─────────────────────────────────────────────
  {
    name: "bff report: removed",
    as: "alice",
    method: "GET",
    path: `${R}/1`,
    removed: "no client calls it; the dashboard reads reports through /api/projects/{id}/reports",
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
    name: "bff metrics list: removed",
    as: "alice",
    method: "GET",
    path: M,
    query: { report_id: "1" },
    removed:
      "no client calls it; the portal records views through /api/participant/{id}/report/metric",
  },

  // ── POST /report-metrics ──────────────────────────────────────────
  {
    name: "bff metrics create: removed",
    as: "alice",
    method: "POST",
    path: M,
    body: { project_report_id: "1", type: "view" },
    removed:
      "no client calls it; the portal records views through /api/participant/{id}/report/metric",
  },
]);
