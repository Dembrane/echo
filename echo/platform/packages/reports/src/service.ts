import type { Access, ProjectAccess } from "@echo/access";
import { BadRequestError, NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import { directusRow } from "@echo/legacy-shape";
import { projectFor } from "@echo/projects";
import { REPORT_COLUMNS, type ReportsStorage, type Row } from "./storage";

export interface ReportDeps {
  readonly store: ReportsStorage;
  readonly access: Access;
  readonly now: () => Date;
}

/** The lean list the dashboard asks for when it names no fields. */
const DEFAULT_FIELDS = [
  "id",
  "date_created",
  "project_id",
  "status",
  "language",
  "show_portal_link",
  "error_code",
  "error_message",
  "scheduled_at",
  "user_instructions",
] as const;

/**
 * The columns a `fields` value names. Hole M-7: the old API passed the list to a
 * superuser Directus client, so a relational path read rows outside the report. Only the
 * report's own columns are served now; `*` still means all of them.
 */
export function parseFields(raw: string | null): readonly string[] {
  if (!raw) return DEFAULT_FIELDS;
  const names = raw
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (!names.length) return DEFAULT_FIELDS;
  const out: string[] = [];
  for (const name of names) {
    if (name === "*") {
      for (const c of REPORT_COLUMNS) if (!out.includes(c)) out.push(c);
      continue;
    }
    if (!(REPORT_COLUMNS as readonly string[]).includes(name))
      throw new BadRequestError(`Unknown field: ${name}`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** A report row as Directus served it: ISO timestamps, bigint ids as numbers. */
export function reportView(row: Row): Row {
  const out = directusRow(row);
  for (const k of ["id", "project_report_id"] as const)
    if (typeof out[k] === "string" && /^\d+$/.test(out[k] as string)) out[k] = Number(out[k]);
  return out;
}

export async function listReports(
  d: ReportDeps,
  who: Signed,
  projectId: string,
  fields: string | null,
  limit: number,
) {
  await projectFor(d.access, who, projectId, "report:view");
  const columns = parseFields(fields);
  const rows = await d.store.projectReports(projectId, columns, limit);
  return rows.map(reportView);
}

/** resolve_report_access: the live report, then report:view on its project. */
async function reportFor(
  d: ReportDeps,
  who: Signed,
  reportId: string,
): Promise<{ report: Row; access: ProjectAccess }> {
  const report = await d.store.report(reportId);
  if (!report || report.deleted_at || !report.project_id)
    throw new NotFoundError("Report not found");
  const access = await projectFor(d.access, who, String(report.project_id), "report:view");
  return { report, access };
}

export async function getReport(d: ReportDeps, who: Signed, reportId: string, content: boolean) {
  const { report } = await reportFor(d, who, reportId);
  const view = reportView(report);
  if (!content) delete view.content;
  return view;
}

export async function reportTimeline(d: ReportDeps, who: Signed, reportId: string) {
  const { report } = await reportFor(d, who, reportId);
  const projectId = String(report.project_id);
  const view = reportView(report);
  const siblings = await d.store.projectReports(projectId, ["id", "date_created"], 1000);
  const project = await d.store.project(projectId);
  const conversations = await d.store.liveConversations(projectId);
  const counts = new Map(
    (await d.store.chunkCounts(conversations.map((c) => String(c.id)))).map((r) => [
      String(r.conversation_id),
      Number(r.n),
    ]),
  );
  const metrics = await d.store.projectMetrics(projectId);
  return {
    report: { id: view.id, date_created: view.date_created, project_id: projectId },
    all_reports: siblings.map(reportView).map((r) => ({ id: r.id, date_created: r.date_created })),
    project_created_at: project ? (directusRow(project).created_at ?? null) : null,
    conversations: conversations.map((c) => {
      const row = directusRow(c);
      return {
        id: row.id,
        created_at: row.created_at ?? null,
        chunk_count: counts.get(String(c.id)) ?? 0,
      };
    }),
    metrics: metrics.map(reportView),
  };
}

export async function listMetrics(d: ReportDeps, who: Signed, reportId: string) {
  await reportFor(d, who, reportId);
  return (await d.store.reportMetrics(reportId)).map(reportView);
}

/**
 * Records a consumption event (a portal view). Needs only report:view, as before: hole
 * L-5 notes an observer can write metrics with a client-set ip; the dashboard relies on
 * it, so the behaviour stays until the metric contract is redone.
 */
export async function createMetric(
  d: ReportDeps,
  who: Signed,
  body: { project_report_id: string; type: string; ip: string | null },
) {
  await reportFor(d, who, body.project_report_id);
  const created = await d.store.insertMetric({
    project_report_id: body.project_report_id,
    type: body.type,
    ...(body.ip !== null && { ip: body.ip }),
    now: d.now().toISOString(),
  });
  return reportView(created);
}
