import type { Access, ProjectAccess } from "@dembrane/access";
import { NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/http";
import { directusRow } from "@dembrane/legacy-shape";
import type { ReportsStorage, Row } from "./storage";

export interface ReportDeps {
  readonly store: ReportsStorage;
  readonly access: Access;
  readonly now: () => Date;
}

/** A report row as Directus served it: ISO timestamps, bigint ids as strings. */
export function reportView(row: Row): Row {
  return directusRow(row);
}

/** resolve_report_access: the live report, then report:view on its project. */
async function reportFor(
  d: ReportDeps,
  who: Signed,
  reportId: string,
): Promise<{ report: Row; access: ProjectAccess }> {
  const report = await d.store.report(reportId);
  if (!report || report.deleted_at || !report.project_id)
    throw new NotFoundError("report.not_found");
  const access = await projectFor(d.access, who, String(report.project_id), "report:view");
  return { report, access };
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
