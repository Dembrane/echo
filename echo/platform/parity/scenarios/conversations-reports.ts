import { conversations, id, projects } from "../fixtures";
import { METRICS, OPTED_IN, P1_DRAFT, P3_REPORT } from "../projects-setup";
import { scenarios } from "../runner/scenario";

// The portal's published report pages and report sign-up: no session, the project id in
// the path. Seed: report 1 on p1 is published.
const { p1, p2, p3 } = projects;
const R = (p: string, tail: string) => `/api/participant/${p}/report${tail}`;
const OPT_OUT_TOKEN = id("f8", 1);
const WITH_TOKEN = `update project_report_notification_participants set email_opt_out_token = '${OPT_OUT_TOKEN}' where id = '${id("f7", 1)}'`;
const P1_DELETED = `update project set deleted_at = now() where id = '${p1}'`;
const CANVAS = `insert into project_report (project_id, status, language, kind, content, date_created)
  values ('${p1}', 'published', 'en', 'canvas', '', now() + interval '1 day')`;

export default scenarios([
  // ── latest ──
  { name: "report latest: published", as: "anonymous", method: "GET", path: R(p1, "/latest") },
  { name: "report latest: none", as: "anonymous", method: "GET", path: R(p2, "/latest") },
  {
    name: "report latest: a newer canvas does not shadow it",
    as: "anonymous",
    method: "GET",
    path: R(p1, "/latest"),
    setup: [CANVAS],
  },
  {
    name: "report latest: drafts are not public",
    as: "anonymous",
    method: "GET",
    path: R(p1, "/latest"),
    setup: [P1_DRAFT, "update project_report set status = 'draft' where id = 1"],
  },
  { name: "report latest: not a uuid", as: "anonymous", method: "GET", path: R("abc", "/latest") },
  {
    name: "report latest: other project",
    as: "anonymous",
    method: "GET",
    path: R(p3, "/latest"),
    setup: [P3_REPORT],
  },
  {
    name: "report latest: deleted project",
    as: "anonymous",
    method: "GET",
    path: R(p1, "/latest"),
    setup: [P1_DELETED],
    differs: "L-21: a soft-deleted project's reports are no longer public",
  },
  // ── detail ──
  { name: "report detail: published", as: "anonymous", method: "GET", path: R(p1, "/1/detail") },
  {
    name: "report detail: wrong project",
    as: "anonymous",
    method: "GET",
    path: R(p3, "/1/detail"),
  },
  { name: "report detail: missing", as: "anonymous", method: "GET", path: R(p1, "/99/detail") },
  {
    name: "report detail: id not an integer",
    as: "anonymous",
    method: "GET",
    path: R(p1, "/abc/detail"),
  },
  {
    name: "report detail: deleted project",
    as: "anonymous",
    method: "GET",
    path: R(p1, "/1/detail"),
    setup: [P1_DELETED],
    differs: "L-21: a soft-deleted project's reports are no longer public",
  },
  // ── views ──
  { name: "report views: none", as: "anonymous", method: "GET", path: R(p1, "/views") },
  {
    name: "report views: recent only",
    as: "anonymous",
    method: "GET",
    path: R(p1, "/views"),
    setup: [METRICS],
  },
  { name: "report views: not a uuid", as: "anonymous", method: "GET", path: R("abc", "/views") },
  // ── metric ──
  {
    name: "report metric: view recorded",
    as: "anonymous",
    method: "POST",
    path: R(p1, "/metric"),
    body: { project_report_id: 1, type: "view" },
  },
  {
    name: "report metric: type defaults to view",
    as: "anonymous",
    method: "POST",
    path: R(p1, "/metric"),
    body: { project_report_id: 1 },
  },
  {
    name: "report metric: report of another project",
    as: "anonymous",
    method: "POST",
    path: R(p3, "/metric"),
    body: { project_report_id: 1 },
  },
  {
    name: "report metric: validation",
    as: "anonymous",
    method: "POST",
    path: R(p1, "/metric"),
    body: { project_report_id: "x" },
  },
  {
    name: "report metric: other types refused",
    as: "anonymous",
    method: "POST",
    path: R(p1, "/metric"),
    body: { project_report_id: 1, type: "download" },
    differs: "L-21: the metric type was client-set; the portal only records views",
  },
  // ── subscribe ──
  {
    name: "report subscribe: new addresses",
    as: "anonymous",
    method: "POST",
    path: "/api/participant/report/subscribe",
    body: {
      emails: ["New@Example.com", "b@example.com"],
      project_id: p1,
      conversation_id: conversations.c1,
    },
    setup: [OPTED_IN],
    ignoreFields: ["email_opt_out_token"],
  },
  {
    name: "report subscribe: already opted in is skipped",
    as: "anonymous",
    method: "POST",
    path: "/api/participant/report/subscribe",
    body: { emails: ["a@example.com"], project_id: p1, conversation_id: conversations.c1 },
    setup: [OPTED_IN],
  },
  {
    name: "report subscribe: validation",
    as: "anonymous",
    method: "POST",
    path: "/api/participant/report/subscribe",
    body: { emails: "a@example.com", project_id: p1 },
  },
  {
    name: "report subscribe: conversation of another project",
    as: "anonymous",
    method: "POST",
    path: "/api/participant/report/subscribe",
    body: { emails: ["x@example.com"], project_id: p1, conversation_id: conversations.c3 },
    differs: "M-19: the conversation must belong to the project it subscribes to",
  },
  // ── unsubscribe and eligibility ──
  {
    name: "report unsubscribe: opt out by token",
    as: "anonymous",
    method: "POST",
    path: R(p1, "/unsubscribe"),
    body: { token: OPT_OUT_TOKEN, email_opt_in: false },
    setup: [OPTED_IN, WITH_TOKEN],
  },
  {
    name: "report unsubscribe: unknown token",
    as: "anonymous",
    method: "POST",
    path: R(p1, "/unsubscribe"),
    body: { token: OPT_OUT_TOKEN, email_opt_in: false },
  },
  {
    name: "report unsubscribe: validation",
    as: "anonymous",
    method: "POST",
    path: R(p1, "/unsubscribe"),
    body: { token: 5 },
  },
  {
    name: "report eligibility: opted in",
    as: "anonymous",
    method: "GET",
    path: "/api/participant/report/unsubscribe/eligibility",
    query: { token: OPT_OUT_TOKEN, project_id: p1 },
    setup: [OPTED_IN, WITH_TOKEN],
  },
  {
    name: "report eligibility: unknown",
    as: "anonymous",
    method: "GET",
    path: "/api/participant/report/unsubscribe/eligibility",
    query: { token: "abc", project_id: p1 },
  },
  {
    name: "report eligibility: empty token",
    as: "anonymous",
    method: "GET",
    path: "/api/participant/report/unsubscribe/eligibility",
    query: { token: "", project_id: p1 },
  },
  {
    name: "report eligibility: missing parameters",
    as: "anonymous",
    method: "GET",
    path: "/api/participant/report/unsubscribe/eligibility",
  },
]);
