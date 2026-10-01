// State the canvas scenarios need and the seed does not hold: canvas turned on for a
// project, canvas reports with a loop, a config revision, generations and loop runs.
import { chats, id, projects, users } from "./fixtures";

export const canvas = {
  p1: "900",
  deleted: "901",
  report: "902",
  unnamed: "903",
  p3: "904",
  loop: id("ca", 1),
  unnamedLoop: id("ca", 2),
  config: id("ca", 3),
  generation: id("ca", 4),
  oldGeneration: id("ca", 5),
  run: id("ca", 6),
  noOpRun: id("ca", 7),
  task: id("ca", 8),
} as const;

const on = (p: string) => `update project set is_canvas_enabled = true where id = '${p}'`;
export const CANVAS_ON_P1 = on(projects.p1);
export const CANVAS_ON_P2 = on(projects.p2);
export const CANVAS_ON_P3 = on(projects.p3);
export const CANVAS_ON_LEGACY = on(projects.legacy);

const report = (rid: string, project: string, kind: string, name: string, extra = "null") =>
  `insert into project_report (id, project_id, kind, status, user_instructions, content, date_created, deleted_at)
   values (${rid}, '${project}', '${kind}', 'published', '${name}', '', '2026-09-20T10:00:00Z', ${extra})`;

/** Canvas 900 on p1 with its loop, a config revision, two generations and two loop runs. */
export const CANVASES: readonly string[] = [
  CANVAS_ON_P1,
  report(canvas.p1, projects.p1, "canvas", "Mobility pulse"),
  report(canvas.deleted, projects.p1, "canvas", "Old pulse", "'2026-09-21T10:00:00Z'"),
  report(canvas.report, projects.p1, "report", "A report"),
  report(canvas.unnamed, projects.p1, "canvas", "Energy pulse"),
  report(canvas.p3, projects.p3, "canvas", "Org B pulse"),
  `insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes,
     acting_directus_user_id, created_from_chat_id, failure_count, caps, created_at, updated_at)
   values ('${canvas.loop}', '${projects.p1}', ${canvas.p1}, 'Mobility loop', 'active',
     '2099-01-01T00:00:00Z', 5, '${users.alice.directus}', '${chats.p1}', 0, '{}',
     '2026-09-20T10:00:00Z', '2026-09-20T11:00:00Z')`,
  `insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes, created_at)
   values ('${canvas.unnamedLoop}', '${projects.p1}', ${canvas.unnamed}, null, 'stopped',
     '2026-09-21T00:00:00Z', 5, '2026-09-20T10:00:00Z')`,
  `insert into canvas_config_revision (id, report_id, brief, gather_spec, cadence_minutes, created_by, note, created_at)
   values ('${canvas.config}', ${canvas.p1}, 'Track mobility themes.', '{"window_minutes": 60}', 5,
     '${users.alice.directus}', 'initial', '2026-09-20T10:00:00Z')`,
  `insert into canvas_generation (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
   values ('${canvas.oldGeneration}', ${canvas.p1}, '${canvas.config}', '<p>first</p>', 'ok', 'scheduled',
     'heard 3 quotes; rejected 1 off-topic', '2026-09-20T10:05:00Z'),
     ('${canvas.generation}', ${canvas.p1}, '${canvas.config}', '<p>second</p>', 'ok', 'edited',
     'direct edit: bigger font; chat_id=${chats.p1}', '2026-09-20T10:30:00Z')`,
  `insert into agent_loop_run (id, loop_id, status, detail, generation_id, started_at, finished_at)
   values ('${canvas.run}', '${canvas.loop}', 'ok', 'heard 3 quotes; rejected 1 off-topic',
     '${canvas.oldGeneration}', '2026-09-20T10:05:00Z', '2026-09-20T10:06:00Z'),
     ('${canvas.noOpRun}', '${canvas.loop}', 'no_op', 'nothing new', null,
     '2026-09-20T10:10:00Z', '2026-09-20T10:10:01Z')`,
  `insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
   values ('${canvas.task}', 'canvas_tick', '{"loop_id": "${canvas.loop}", "tick_kind": "scheduled"}',
     '2099-01-01T00:00:00Z', 'scheduled', 0, '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z')`,
];
