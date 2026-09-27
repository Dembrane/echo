import { id, projects, users } from "../fixtures";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

// A canvas on p1 (report 50) with its config, active loop, one generation and one run, and
// the same shape on p2 for the observer and external cases.
const { p1, p2, p3, legacy } = projects;
const loop = id("ca", 1);
const cfg = id("ca", 2);
const gen = id("ca", 3);
const run = id("ca", 4);
const chat = id("ca", 5);

const ENABLE_P1 = `update project set is_canvas_enabled = true where id = '${p1}'`;
const ENABLE_P2 = `update project set is_canvas_enabled = true where id = '${p2}'`;
function canvasOn(project: string, report: number, n: number) {
  const L = id("ca", 10 + n);
  const C = id("ca", 20 + n);
  const G = id("ca", 30 + n);
  const R = id("ca", 40 + n);
  return [
    `insert into project_report (id, project_id, kind, status, user_instructions, content, date_created, user_created)
      values (${report}, '${project}', 'canvas', 'published', 'Mood wall', '', '2026-09-01T10:00:00Z', '${users.alice.directus}')`,
    `insert into canvas_config_revision (id, report_id, brief, gather_spec, cadence_minutes, created_by, note, created_at)
      values ('${C}', ${report}, 'Show the mood', '{"window_minutes": 60}', 5, '${users.alice.directus}', 'initial', '2026-09-01T10:00:00Z')`,
    `insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes, acting_directus_user_id, failure_count, caps, created_at, updated_at)
      values ('${L}', '${project}', ${report}, 'Mood wall', 'active', now() + interval '2 days', 5, '${users.alice.directus}', 0, '{}', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')`,
    `insert into canvas_generation (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
      values ('${G}', ${report}, '${C}', '<p>hi</p>', 'ok', 'scheduled', 'first draw', '2026-09-01T10:05:00Z')`,
    `insert into agent_loop_run (id, loop_id, status, detail, generation_id, started_at, finished_at)
      values ('${R}', '${L}', 'ok', 'first draw', '${G}', '2026-09-01T10:04:00Z', '2026-09-01T10:05:00Z')`,
  ];
}
const P1_CANVAS = [
  ENABLE_P1,
  `insert into project_report (id, project_id, kind, status, user_instructions, content, date_created, user_created)
    values (50, '${p1}', 'canvas', 'published', 'My canvas', '', '2026-09-01T10:00:00Z', '${users.alice.directus}')`,
  `insert into canvas_config_revision (id, report_id, brief, gather_spec, cadence_minutes, created_by, note, created_at)
    values ('${cfg}', 50, 'Show the mood', '{"window_minutes": 60}', 5, '${users.alice.directus}', 'initial', '2026-09-01T10:00:00Z')`,
  `insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes, acting_directus_user_id, failure_count, caps, created_at, updated_at)
    values ('${loop}', '${p1}', 50, 'My canvas', 'active', now() + interval '2 days', 5, '${users.alice.directus}', 0, '{}', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')`,
  `insert into canvas_generation (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
    values ('${gen}', 50, '${cfg}', '<p>hi</p>', 'ok', 'scheduled', 'first draw', '2026-09-01T10:05:00Z')`,
  `insert into agent_loop_run (id, loop_id, status, detail, generation_id, started_at, finished_at)
    values ('${run}', '${loop}', 'ok', 'first draw', '${gen}', '2026-09-01T10:04:00Z', '2026-09-01T10:05:00Z')`,
];
const P2_CANVAS = [P2_OPEN, ENABLE_P2, ...canvasOn(p2, 60, 2)];
const P1_CHAT = `insert into project_chat (id, project_id, name, date_created) values ('${chat}', '${p1}', 'Planning', now())`;
const P1_STOPPED = `update agent_loop set status = 'stopped' where id = '${loop}'`;
const P1_NO_LOOP = `delete from agent_loop_run where loop_id = '${loop}'; delete from agent_loop where id = '${loop}'`;
const P1_PENDING_TICK = `insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
  values ('${id("ca", 6)}', 'canvas_tick', '{"loop_id": "${loop}", "tick_kind": "scheduled"}', now() + interval '5 minutes', 'scheduled', 0, now(), now())`;
const P1_HOST_ITEM = `update agent_loop set canvas_host_items = '[{"id": "${id("ca", 7)}", "text": "Ask about buses", "person": null, "target_tab": "story", "source": {"chat_id": null, "message_id": null}, "added_at": "2026-09-01T10:10:00.000000+00:00", "removed_at": null}]' where id = '${loop}'`;

const base = "/api/v2/bff/canvases";
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const createBody =
  (extra: Record<string, unknown> = {}) =>
  () => ({
    project_id: p1,
    name: "Energy wall",
    brief: "Show what residents say about energy",
    expires_at: inDays(2),
    ...extra,
  });

// echo main reads and writes canvas ledger columns and config tabs the deployed schema
// never got. Directus drops the unknown tabs on write and a read naming them returns no
// row, so on the old side every canvas has no config and no loop: config and loop come
// back null, loop routes answer 404 "Canvas loop not found" and host items 500. The port
// adds the columns (migration 0005) and differs only there; every other field matches.
const LEDGERS =
  "canvas ledger columns missing from the deployed schema: the Python sees no loop or config";

export default scenarios([
  // ── list ────────────────────────────────────────────────────────────
  {
    name: "canvas list: flag off for the project",
    as: "alice",
    method: "GET",
    path: base,
    query: { project_id: p1 },
  },
  {
    name: "canvas list: none yet",
    as: "alice",
    method: "GET",
    path: base,
    query: { project_id: p1 },
    setup: [ENABLE_P1],
  },
  {
    name: "canvas list: owner",
    as: "alice",
    method: "GET",
    path: base,
    query: { project_id: p1 },
    setup: P1_CANVAS,
    differs: LEDGERS,
  },
  { name: "canvas list: missing project_id", as: "alice", method: "GET", path: base },
  {
    name: "canvas list: other tenant",
    as: "bob",
    method: "GET",
    path: base,
    query: { project_id: p1 },
    setup: [ENABLE_P1],
  },
  {
    name: "canvas list: not onboarded",
    as: "dave",
    method: "GET",
    path: base,
    query: { project_id: legacy },
  },
  {
    name: "canvas list: anonymous",
    as: "anonymous",
    method: "GET",
    path: base,
    query: { project_id: p1 },
  },
  {
    name: "canvas list: unknown project",
    as: "alice",
    method: "GET",
    path: base,
    query: { project_id: "nope" },
  },
  {
    name: "canvas list: other tenant's own project off",
    as: "bob",
    method: "GET",
    path: base,
    query: { project_id: p3 },
  },

  // ── create ──────────────────────────────────────────────────────────
  {
    name: "canvas create: owner",
    as: "alice",
    method: "POST",
    path: base,
    body: createBody(),
    setup: [ENABLE_P1],
    differs: LEDGERS,
  },
  { name: "canvas create: flag off", as: "alice", method: "POST", path: base, body: createBody() },
  {
    name: "canvas create: observer cannot",
    as: "rita",
    method: "POST",
    path: base,
    body: createBody({ project_id: p2 }),
    setup: [P2_OPEN, ENABLE_P2],
  },
  {
    name: "canvas create: expiry in the past",
    as: "alice",
    method: "POST",
    path: base,
    body: createBody({ expires_at: inDays(-1) }),
    setup: [ENABLE_P1],
  },
  {
    name: "canvas create: expiry beyond a week",
    as: "alice",
    method: "POST",
    path: base,
    body: createBody({ expires_at: inDays(9) }),
    setup: [ENABLE_P1],
  },
  {
    name: "canvas create: validation",
    as: "alice",
    method: "POST",
    path: base,
    body: {
      project_id: p1,
      name: "",
      brief: "b",
      cadence_minutes: 1,
      expires_at: "tomorrow",
      tabs: ["a"],
    },
    setup: [ENABLE_P1],
  },
  {
    name: "canvas create: missing body",
    as: "alice",
    method: "POST",
    path: base,
    setup: [ENABLE_P1],
  },
  {
    name: "canvas create: anonymous",
    as: "anonymous",
    method: "POST",
    path: base,
    body: createBody(),
  },

  // ── preview ─────────────────────────────────────────────────────────
  {
    name: "canvas preview: validation",
    as: "alice",
    method: "POST",
    path: `${base}/preview`,
    body: { project_id: p1, brief: "" },
    setup: [ENABLE_P1],
  },
  {
    name: "canvas preview: observer cannot",
    as: "rita",
    method: "POST",
    path: `${base}/preview`,
    body: { project_id: p2, brief: "Show the mood" },
    setup: [P2_OPEN, ENABLE_P2],
  },
  {
    name: "canvas preview: flag off",
    as: "alice",
    method: "POST",
    path: `${base}/preview`,
    body: { project_id: p1, brief: "Show the mood" },
  },
  {
    name: "canvas preview: other tenant",
    as: "bob",
    method: "POST",
    path: `${base}/preview`,
    body: { project_id: p1, brief: "Show the mood" },
    setup: [ENABLE_P1],
  },

  // ── read one ────────────────────────────────────────────────────────
  {
    name: "canvas get: owner",
    as: "alice",
    method: "GET",
    path: `${base}/50`,
    setup: P1_CANVAS,
    differs: LEDGERS,
  },
  {
    name: "canvas get: missing",
    as: "alice",
    method: "GET",
    path: `${base}/99`,
    setup: [ENABLE_P1],
  },
  {
    name: "canvas get: a report that is not a canvas",
    as: "alice",
    method: "GET",
    path: `${base}/1`,
    setup: [ENABLE_P1],
  },
  {
    name: "canvas get: flag off",
    as: "alice",
    method: "GET",
    path: `${base}/50`,
    setup: P1_CANVAS.slice(1),
  },
  {
    name: "canvas get: other tenant",
    as: "bob",
    method: "GET",
    path: `${base}/50`,
    setup: P1_CANVAS,
  },
  {
    name: "canvas get: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${base}/50`,
    setup: P1_CANVAS,
  },
  {
    name: "canvas get: observer reads",
    as: "rita",
    method: "GET",
    path: `${base}/60`,
    setup: P2_CANVAS,
    differs: LEDGERS,
  },

  // ── events (the success stream never ends; the runner can only compare refusals) ─
  {
    name: "canvas events: missing",
    as: "alice",
    method: "GET",
    path: `${base}/99/events`,
    setup: [ENABLE_P1],
  },
  {
    name: "canvas events: other tenant",
    as: "bob",
    method: "GET",
    path: `${base}/50/events`,
    setup: P1_CANVAS,
  },
  {
    name: "canvas events: not a canvas",
    as: "alice",
    method: "GET",
    path: `${base}/1/events`,
    setup: [ENABLE_P1],
  },
  { name: "canvas events: anonymous", as: "anonymous", method: "GET", path: `${base}/50/events` },

  // ── generations ─────────────────────────────────────────────────────
  {
    name: "canvas generations: owner",
    as: "alice",
    method: "GET",
    path: `${base}/50/generations`,
    setup: P1_CANVAS,
  },
  {
    name: "canvas generations: limit out of range",
    as: "alice",
    method: "GET",
    path: `${base}/50/generations`,
    query: { limit: "0" },
    setup: P1_CANVAS,
  },
  {
    name: "canvas generations: limit one",
    as: "alice",
    method: "GET",
    path: `${base}/50/generations`,
    query: { limit: "1" },
    setup: P1_CANVAS,
  },
  {
    name: "canvas generations: observer",
    as: "rita",
    method: "GET",
    path: `${base}/60/generations`,
    setup: P2_CANVAS,
  },
  {
    name: "canvas generations: other tenant",
    as: "bob",
    method: "GET",
    path: `${base}/50/generations`,
    setup: P1_CANVAS,
  },

  // ── update ──────────────────────────────────────────────────────────
  {
    name: "canvas update: owner",
    as: "alice",
    method: "PATCH",
    path: `${base}/50`,
    body: { name: "Renamed", brief: "New brief", cadence_minutes: 10 },
    setup: P1_CANVAS,
    differs: LEDGERS,
  },
  {
    name: "canvas update: observer cannot",
    as: "rita",
    method: "PATCH",
    path: `${base}/60`,
    body: { name: "Renamed", brief: "New brief" },
    setup: P2_CANVAS,
  },
  {
    name: "canvas update: validation",
    as: "alice",
    method: "PATCH",
    path: `${base}/50`,
    body: { name: "x".repeat(161) },
    setup: P1_CANVAS,
  },

  // ── refresh ─────────────────────────────────────────────────────────
  {
    name: "canvas refresh: owner",
    as: "alice",
    method: "POST",
    path: `${base}/50/refresh`,
    setup: P1_CANVAS,
    differs:
      "the Python saw no loop (ledger columns missing) and ran any tick inside the request; the port starts it on the worker and answers 202 at once",
  },
  {
    name: "canvas refresh: observer cannot",
    as: "rita",
    method: "POST",
    path: `${base}/60/refresh`,
    setup: P2_CANVAS,
  },
  {
    name: "canvas refresh: no loop",
    as: "alice",
    method: "POST",
    path: `${base}/50/refresh`,
    setup: [...P1_CANVAS, P1_NO_LOOP],
  },

  // ── host items ──────────────────────────────────────────────────────
  {
    name: "canvas host item: add",
    as: "alice",
    method: "POST",
    path: `${base}/50/host-items`,
    body: {
      text: "Ask about buses",
      target_tab: "cloud",
      person: "Host",
      chat_id: chat,
      message_id: "m1",
    },
    setup: [...P1_CANVAS, P1_CHAT],
    differs: LEDGERS,
  },
  {
    name: "canvas host item: validation",
    as: "alice",
    method: "POST",
    path: `${base}/50/host-items`,
    body: { text: "" },
    setup: P1_CANVAS,
  },
  {
    name: "canvas host item: observer cannot",
    as: "rita",
    method: "POST",
    path: `${base}/60/host-items`,
    body: { text: "Hi" },
    setup: P2_CANVAS,
  },
  {
    name: "canvas host item: remove",
    as: "alice",
    method: "POST",
    path: `${base}/50/host-items/remove`,
    body: { item: "buses" },
    setup: [...P1_CANVAS, P1_HOST_ITEM],
    differs: LEDGERS,
  },
  {
    name: "canvas host item: remove validation",
    as: "alice",
    method: "POST",
    path: `${base}/50/host-items/remove`,
    body: {},
    setup: P1_CANVAS,
  },

  // ── loop actions ────────────────────────────────────────────────────
  {
    name: "canvas loop: pause",
    as: "alice",
    method: "POST",
    path: `${base}/50/loop/pause`,
    setup: [...P1_CANVAS, P1_PENDING_TICK],
    differs: LEDGERS,
  },
  {
    name: "canvas loop: resume ended",
    as: "alice",
    method: "POST",
    path: `${base}/50/loop/resume`,
    setup: [...P1_CANVAS, P1_STOPPED],
    differs: LEDGERS,
  },
  {
    name: "canvas loop: stop",
    as: "alice",
    method: "POST",
    path: `${base}/50/loop/stop`,
    setup: [...P1_CANVAS, P1_PENDING_TICK],
    differs: LEDGERS,
  },
  {
    name: "canvas loop: unknown action",
    as: "alice",
    method: "POST",
    path: `${base}/50/loop/bogus`,
    setup: P1_CANVAS,
  },
  {
    name: "canvas loop: observer cannot",
    as: "rita",
    method: "POST",
    path: `${base}/60/loop/pause`,
    setup: P2_CANVAS,
  },
  {
    name: "canvas loop settings: update",
    as: "alice",
    method: "PATCH",
    path: `${base}/50/loop`,
    body: () => ({ cadence_minutes: 15, expires_at: inDays(3) }),
    setup: [...P1_CANVAS, P1_PENDING_TICK],
    differs: LEDGERS,
  },
  {
    name: "canvas loop settings: expiry in the past",
    as: "alice",
    method: "PATCH",
    path: `${base}/50/loop`,
    body: () => ({ cadence_minutes: 15, expires_at: inDays(-1) }),
    setup: P1_CANVAS,
    differs: LEDGERS,
  },
  {
    name: "canvas loop settings: validation",
    as: "alice",
    method: "PATCH",
    path: `${base}/50/loop`,
    body: { cadence_minutes: 500 },
    setup: P1_CANVAS,
  },
]);
