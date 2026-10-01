// Setup statements the projects scenarios share: states the seed does not hold, applied
// to both databases before the request.
import { conversations, id, projects, users, workspaces } from "./fixtures";

export const extra = {
  project: id("f0", 5),
  conversation: id("c1", 9),
  tag: id("f2", 9),
  run: id("f3", 1),
  methodology: id("f4", 1),
  methodologyVersion: id("f4", 2),
  template: id("f5", 1),
  workspaceTemplate: id("f5", 2),
  researchTemplate: id("f5", 3),
  webhook: id("f1", 2),
  task: id("f6", 1),
} as const;

/** p2 made visible to the whole research workspace, so its observer (rita), external (bob) and member (alice) reach it. */
export const P2_OPEN = `update project set visibility = 'workspace' where id = '${projects.p2}'`;

export const EMPTY_PROJECT = `insert into project (id, name, language, workspace_id, directus_user_id, is_conversation_allowed, visibility, created_at, updated_at)
  values ('${extra.project}', 'Empty', 'en', '${workspaces.aDefault}', '${users.alice.directus}', true, 'workspace', now(), now())`;

export const UNTRANSCRIBED = `insert into conversation (id, project_id, participant_name, created_at, updated_at)
  values ('${extra.conversation}', '${extra.project}', 'Silent', now(), now())`;

export const P2_TAG = `insert into project_tag (id, project_id, text, sort, created_at, updated_at)
  values ('${extra.tag}', '${projects.p2}', 'research', 1, now(), now())`;

export const P1_DRAFT = `insert into project_report (project_id, status, language, kind, content, date_created)
  values ('${projects.p1}', 'draft', 'en', 'report', '', now())`;

export const P2_REPORT = `insert into project_report (project_id, status, language, kind, content, date_created)
  values ('${projects.p2}', 'published', 'nl', 'report', '# Onderzoek', now())`;

export const P3_REPORT = `insert into project_report (project_id, status, language, kind, content, date_created)
  values ('${projects.p3}', 'published', 'en', 'report', '# Kickoff', now())`;

/** Report 2 on p1, scheduled, with the task the runner would fire. */
export const P1_SCHEDULED = [
  `insert into project_report (project_id, status, language, kind, content, date_created, scheduled_at)
    values ('${projects.p1}', 'scheduled', 'en', 'report', '', now(), '2099-01-01T10:00:00Z')`,
  `insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
    values ('${extra.task}', 'generate_report', '{"report_id": 2, "project_id": "${projects.p1}", "language": "en", "user_instructions": ""}', '2099-01-01T10:00:00Z', 'scheduled', 0, now(), now())`,
];

export const P1_FAILED_REPORT = `update project_report set status = 'error' where id = 1`;

export const NEWER_CONVERSATION = `insert into conversation (id, project_id, participant_name, created_at, updated_at)
  values ('${extra.conversation}', '${projects.p1}', 'Late', now() + interval '1 day', now())`;

export const METRICS = `insert into project_report_metric (project_report_id, type, date_created)
  values (1, 'view', now()), (1, 'view', now() - interval '1 hour')`;

export const OPTED_IN = `insert into project_report_notification_participants (id, project_id, email, email_opt_in, conversation_id)
  values ('${id("f7", 1)}', '${projects.p1}', 'a@example.com', true, '${conversations.c1}'),
         ('${id("f7", 2)}', '${projects.p1}', 'b@example.com', false, '${conversations.c1}')`;

const methodology = (vis: string, ws: string | null, owner: string, seeded = false) => [
  `insert into methodology (id, name, description, framing, owner_directus_user_id, workspace_id, visibility, is_seeded, created_at)
    values ('${extra.methodology}', 'Deliberation', 'Structured dialogue', 'Frame', '${owner}', ${ws ? `'${ws}'` : "null"}, '${vis}', ${seeded}, now())`,
  `insert into methodology_version (id, methodology_id, content, note, created_by, created_at)
    values ('${extra.methodologyVersion}', '${extra.methodology}', '{"steps": 3}', 'Initial history', '${owner}', now())`,
];
export const PUBLIC_METHODOLOGY = methodology("public", null, users.admin.directus, false);
export const SEEDED_METHODOLOGY = methodology("public", null, users.admin.directus, true);
export const PRIVATE_METHODOLOGY = methodology("private", workspaces.aDefault, users.erin.directus);
export const WORKSPACE_METHODOLOGY = methodology(
  "workspace",
  workspaces.aDefault,
  users.erin.directus,
);

export const TEMPLATES = [
  `insert into prompt_template (id, title, content, scope, user_created, sort, date_created)
    values ('${extra.template}', 'Mine', 'Summarise', 'user', '${users.alice.directus}', 1, now())`,
  `insert into prompt_template (id, title, content, scope, workspace_id, user_created, sort, is_public, date_created)
    values ('${extra.workspaceTemplate}', 'Shared', 'Compare', 'workspace', '${workspaces.aDefault}', '${users.erin.directus}', 2, true, now())`,
  `insert into prompt_template (id, title, content, scope, workspace_id, user_created, sort, date_created)
    values ('${extra.researchTemplate}', 'Research', 'Code', 'workspace', '${workspaces.aResearch}', '${users.erin.directus}', 1, now())`,
];

export const P2_WEBHOOK = `insert into project_webhook (id, project_id, name, url, events, status, date_created)
  values ('${extra.webhook}', '${projects.p2}', 'Research sink', 'https://example.com/hook', '["conversation.started"]', 'published', now())`;
