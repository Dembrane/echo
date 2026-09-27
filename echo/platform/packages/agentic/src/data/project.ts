import { NotFoundError, newId } from "@echo/core";
import type { Signed } from "@echo/http";
import { projectFor, projectsStorage } from "@echo/projects";
import { agentProject } from "../access";
import {
  type DataDeps,
  isUuid,
  projectRow,
  projectWorkspaceId,
  type Row,
  row,
  sqlOf,
} from "./deps";

/**
 * The fields the BFF project PATCH accepts (bff/tags.py ProjectUpdate), so the assistant's
 * proposeProjectUpdate diff and the apply path agree on what exists. Kept in step with
 * @echo/projects' PROJECT_UPDATE_FIELDS, which that package does not export.
 */
const PROJECT_UPDATE_FIELDS = [
  "name",
  "context",
  "language",
  "is_conversation_allowed",
  "default_conversation_title",
  "default_conversation_description",
  "default_conversation_finish_text",
  "default_conversation_ask_for_participant_name",
  "default_conversation_ask_for_participant_email",
  "default_conversation_transcript_prompt",
  "default_conversation_tutorial_slug",
  "get_reply_mode",
  "get_reply_prompt",
  "is_get_reply_enabled",
  "is_verify_enabled",
  "is_verify_on_finish_enabled",
  "is_canvas_enabled",
  "is_dembrane_event_cta_enabled",
  "selected_verification_key_list",
  "is_project_notification_subscription_allowed",
  "anonymize_transcripts",
  "enable_ai_title_and_tags",
  "conversation_title_prompt",
  "image_generation_model",
  "tutorial_slug",
  "host_guide",
  "methodology_version_id",
  "legal_basis",
  "privacy_policy_url",
] as const;

/** The project must exist before anything else is said about it, staff included. */
async function existingProject(d: DataDeps, projectId: string): Promise<Row> {
  const p = await projectRow(d, projectId);
  if (!p) throw new NotFoundError("Project not found");
  return p;
}

/** GET /agentic/projects/{p}/settings: the editable settings, read-only. */
export async function projectSettings(d: DataDeps, who: Signed, projectId: string) {
  const project = await existingProject(d, projectId);
  await agentProject(d.access, who, projectId);
  return Object.fromEntries(PROJECT_UPDATE_FIELDS.map((f) => [f, project[f] ?? null]));
}

/** GET /v2/bff/tags?project_id=: the tag vocabulary participants pick from. */
export async function projectTags(d: DataDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:read");
  return projectsStorage(d.db).tags(projectId);
}

async function tagRows(d: DataDeps, projectId: string) {
  return projectsStorage(d.db).tags(projectId);
}

/**
 * POST /agentic/projects/{p}/tags. Adds are deduplicated case-insensitively against the
 * vocabulary and each other; removes match exact text case-insensitively and take the
 * tag's conversation links with them, so no reference dangles.
 */
export async function editProjectTags(
  d: DataDeps,
  who: Signed,
  projectId: string,
  add: readonly string[],
  remove: readonly string[],
) {
  await agentProject(d.access, who, projectId);
  const sql = sqlOf(d);
  const existing = await tagRows(d, projectId);
  const byLower = new Map<string, Row>();
  let maxSort = 0;
  for (const r of existing) {
    const t = String(r.text ?? "").trim();
    if (t && !byLower.has(t.toLowerCase())) byLower.set(t.toLowerCase(), r);
    const n = Number.parseInt(String(r.sort ?? 0), 10);
    if (!Number.isNaN(n)) maxSort = Math.max(maxSort, n);
  }
  const added: string[] = [];
  const seen = new Set<string>();
  for (const raw of add) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (byLower.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    maxSort += 1;
    await sql`
      insert into project_tag (id, project_id, text, sort, created_at)
      values (${newId()}, ${projectId}, ${t}, ${maxSort}, ${d.now().toISOString()})`;
    added.push(t);
  }
  const removed: string[] = [];
  for (const raw of remove) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    const r = byLower.get(t.toLowerCase());
    if (!r?.id) continue;
    await sql`delete from conversation_project_tag where project_tag_id = ${String(r.id)}`;
    await sql`delete from project_tag where id = ${String(r.id)}`;
    removed.push(String(r.text ?? t));
  }
  const tags = await tagRows(d, projectId);
  return { project_id: projectId, added, removed, count: tags.length, tags };
}

/** GET /agentic/projects/{p}/goal */
export async function projectGoal(d: DataDeps, who: Signed, projectId: string) {
  await agentProject(d.access, who, projectId);
  const revisions = await projectsStorage(d.db).goalRevisions(projectId);
  return { project_id: projectId, current: revisions[0] ?? null, revisions };
}

/** GET /agentic/projects/{p}/methodologies: what the workspace may pick, with version counts. */
export async function methodologies(d: DataDeps, who: Signed, projectId: string) {
  await agentProject(d.access, who, projectId);
  const workspaceId = await projectWorkspaceId(d, projectId);
  if (workspaceId === null) return { project_id: projectId, methodologies: [] };
  const store = projectsStorage(d.db);
  const out = [];
  for (const m of await store.visibleMethodologies(workspaceId, who.directusUserId)) {
    const versions = await store.methodologyVersions(m.id);
    const latest = versions[0];
    out.push({
      id: m.id,
      name: m.name ?? null,
      description: m.description ?? null,
      framing: m.framing ?? null,
      is_seeded: Boolean(m.is_seeded),
      latest_version: latest
        ? {
            id: latest.id ?? null,
            note: latest.note ?? null,
            created_at: latest.created_at ?? null,
          }
        : null,
      versions_count: versions.length,
    });
  }
  return { project_id: projectId, methodologies: out };
}

// Reports: the host's deliverable. `kind` is filtered because a canvas is also a
// project_report row; without it canvases would read as untitled reports.
const VISIBLE_STATUSES = ["published", "scheduled", "draft", "archived"];

const reportFields = (r: Row) => ({
  id: r.id ?? null,
  status: r.status ?? null,
  date_created: r.date_created ?? null,
  language: r.language ?? null,
  user_instructions: r.user_instructions ?? null,
});

/** First markdown H1, which is how the dashboard titles a report. */
export function reportTitle(content: unknown): string | null {
  for (const line of String(content ?? "").split(/\r\n|\r|\n/)) {
    const s = line.trim();
    if (s.startsWith("# ")) return s.slice(2).trim() || null;
  }
  return null;
}

/** GET /agentic/projects/{p}/reports: newest 20, without content, which would crowd the turn. */
export async function reports(d: DataDeps, who: Signed, projectId: string) {
  await agentProject(d.access, who, projectId);
  const rows = isUuid(projectId)
    ? await sqlOf(d)`
        select id, status, date_created, language, user_instructions from project_report
        where project_id = ${projectId} and kind = 'report'
          and status = any(${VISIBLE_STATUSES}) and deleted_at is null
        order by date_created desc limit 20`
    : [];
  return { project_id: projectId, reports: rows.map((r) => reportFields(row(r as Row))) };
}

/** GET /agentic/projects/{p}/reports/{id}: one report with content and its title. */
export async function report(d: DataDeps, who: Signed, projectId: string, reportId: string) {
  await agentProject(d.access, who, projectId);
  const [r] =
    /^\d+$/.test(reportId.trim()) && isUuid(projectId)
      ? await sqlOf(d)`
          select id, status, date_created, language, user_instructions, content
          from project_report
          where id = ${reportId.trim()} and project_id = ${projectId} and kind = 'report'
            and deleted_at is null
          limit 1`
      : [];
  if (!r) throw new NotFoundError("Report not found");
  const out = row(r as Row);
  return { ...reportFields(out), content: out.content ?? null, title: reportTitle(out.content) };
}
