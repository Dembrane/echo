import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  newId,
  ValidationError,
} from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/http";
import { directusRow, PaymentRequiredError, pythonIso } from "@dembrane/legacy-shape";
import { generateReport, notifyReportSubscribers } from "./jobs";
import type { ProjectDeps } from "./projects";

/** The scheduled_task type the scheduler runner turns into a report generation. */
export const TASK_GENERATE_REPORT = "generate_report";
const MIN_LEAD_MS = 10 * 60_000;

function reportId(raw: number): bigint {
  return BigInt(raw);
}

/** First markdown heading of a report, which the dashboard shows as its title. */
export function reportTitle(content: string | null): string | null {
  if (!content) return null;
  const m = /^#\s+(.+)$/m.exec(content);
  return m?.[1]?.trim() ?? null;
}

/**
 * Parses a client schedule the way Python's datetime.fromisoformat does for the forms the
 * dashboard sends; a naive time is UTC. Must be at least ten minutes out.
 */
export function parseSchedule(raw: string, now: Date): Date {
  const bad = () => new ValidationError("report.schedule_invalid", { params: { value: raw } });
  const m = ISO_FORMS.exec(raw);
  if (!m) throw bad();
  const [, date, h = "00", mi = "00", s = "00", frac = "", tz] = m;
  let zone = tz ?? "Z";
  if (zone !== "Z" && !zone.includes(":"))
    zone = zone.length === 3 ? `${zone}:00` : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const d = new Date(`${date}T${h}:${mi}:${s}.${frac.padEnd(3, "0").slice(0, 3)}${zone}`);
  if (Number.isNaN(d.getTime())) throw bad();
  if (d.getTime() <= now.getTime() + MIN_LEAD_MS)
    throw new BadRequestError("report.schedule_too_soon");
  return d;
}

const ISO_FORMS =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Starts a report, now or at a scheduled time. Generating needs report:generate; a free
 * workspace gets one report, and reports on a sample copy neither need nor spend it. One
 * draft at a time per project, so a double click does not start two generations.
 */
export async function createReport(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  body: { language: string | null; user_instructions: string | null; scheduled_at: string | null },
) {
  const pa = await projectFor(d.access, who, projectId, "report:generate");
  if (pa.tier === "free" && pa.project.workspaceId && !pa.project.isSample) {
    if ((await d.store.countWorkspaceReports(pa.project.workspaceId)) >= 1)
      throw new PaymentRequiredError("billing.tier_limit", {
        params: { limit: "report" },
        details: { error: "FREE_TIER_LIMIT", limit: "report", upgrade_cta_tier: "changemaker" },
      });
  }
  const language = body.language || "en";
  const now = d.now();
  const scheduled = body.scheduled_at ? parseSchedule(body.scheduled_at, now) : null;
  if (!scheduled && (await d.store.hasDraftReport(projectId)))
    throw new ConflictError("report.already_generating");

  return d.store.transaction(async ({ store, sql }) => {
    const created = await store.insertReport({
      project_id: projectId,
      language,
      content: "",
      status: scheduled ? "scheduled" : "draft",
      user_created: who.directusUserId,
      date_created: now.toISOString(),
    });
    const extra = {
      ...(body.user_instructions && { user_instructions: body.user_instructions }),
      ...(scheduled && { scheduled_at: scheduled.toISOString() }),
    };
    if (Object.keys(extra).length)
      await store.updateReport(created.id, { ...extra, date_updated: now.toISOString() });

    if (!scheduled) {
      await d.jobs.enqueue(
        generateReport,
        {
          projectId,
          reportId: Number(created.id),
          language,
          userInstructions: body.user_instructions ?? "",
        },
        { tx: sql },
      );
    } else {
      await store.scheduleTask({
        id: newId(),
        task_type: TASK_GENERATE_REPORT,
        // The id is the string Directus returned; the runner reads either form.
        payload: {
          report_id: String(created.id),
          project_id: projectId,
          language,
          user_instructions: body.user_instructions ?? "",
        },
        scheduled_at: scheduled.toISOString(),
        status: "scheduled",
        attempts: 0,
        created_at: pythonIso(now),
        updated_at: pythonIso(now),
      });
    }
    // The response is the row as first written, before instructions and schedule were added.
    return directusRow(created);
  });
}

export async function listReports(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "report:view", "v1");
  const rows = await d.store.reportsForList(projectId);
  return rows.map((r) => {
    const row = directusRow(r);
    return {
      id: row.id,
      status: row.status,
      date_created: row.date_created,
      language: row.language,
      user_instructions: row.user_instructions,
      scheduled_at: row.scheduled_at,
      title: reportTitle(r.content),
    };
  });
}

export async function latestReport(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "report:view", "v1");
  const r = await d.store.latestReport(projectId);
  if (!r) return null;
  return { ...directusRow(r), content: null, title: reportTitle(r.content) };
}

async function boundReport(d: ProjectDeps, projectId: string, rid: number) {
  const r = await d.store.reportInProject(reportId(rid), projectId);
  if (!r) throw new NotFoundError("report.not_found");
  return r;
}

/**
 * Edits a report of this project (spec C-3: the report id was not bound to the project).
 * Publishing or scheduling needs report:publish; every other change needs project:update
 * (spec M-8: any reader could rewrite content). Publishing archives the project's other
 * published reports; moving a schedule re-points its scheduled task.
 */
export async function updateReport(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  rid: number,
  body: {
    status: string | null;
    show_portal_link: boolean | null;
    content: string | null;
    scheduled_at: string | null;
  },
) {
  const publishing = body.status === "published" || body.status === "scheduled";
  const editing =
    (body.status !== null && !publishing) ||
    body.show_portal_link !== null ||
    body.content !== null ||
    body.scheduled_at !== null;
  if (publishing) await projectFor(d.access, who, projectId, "report:publish");
  if (editing || !publishing) await projectFor(d.access, who, projectId, "project:update");
  await boundReport(d, projectId, rid);

  const now = d.now();
  const payload: Record<string, unknown> = {};
  if (body.status !== null) payload.status = body.status;
  if (body.show_portal_link !== null) payload.show_portal_link = body.show_portal_link;
  if (body.content !== null) payload.content = body.content;
  let scheduled: Date | null = null;
  if (body.scheduled_at !== null) {
    scheduled = parseSchedule(body.scheduled_at, now);
    payload.scheduled_at = scheduled.toISOString();
  }
  if (!Object.keys(payload).length) throw new BadRequestError("request.nothing_to_update");

  return d.store.transaction(async ({ store, sql }) => {
    const stamp = now.toISOString();
    // Locked, so of two publishes at once only the first emails the subscribers.
    const [before] = await sql`select status from project_report where id = ${rid} for update`;
    if (payload.status === "published")
      for (const other of await store.otherPublishedReports(projectId, reportId(rid)))
        await store.updateReport(other, { status: "archived", date_updated: stamp });
    const updated = await store.updateReport(reportId(rid), { ...payload, date_updated: stamp });
    if (!updated) throw new NotFoundError("report.not_found");
    if (updated.status === "published" && before?.status !== "published")
      await d.jobs.enqueue(notifyReportSubscribers, { projectId, reportId: rid }, { tx: sql });
    if (scheduled && updated.status === "scheduled") {
      await store.cancelScheduledTasks(TASK_GENERATE_REPORT, { report_id: rid }, pythonIso(now));
      await store.scheduleTask({
        id: newId(),
        task_type: TASK_GENERATE_REPORT,
        payload: {
          report_id: rid,
          project_id: projectId,
          language: updated.language || "en",
          user_instructions: updated.user_instructions || "",
        },
        scheduled_at: scheduled.toISOString(),
        status: "scheduled",
        attempts: 0,
        created_at: pythonIso(now),
        updated_at: pythonIso(now),
      });
    }
    return directusRow(updated);
  });
}

/** Soft delete; needs report:delete (spec H-9: any reader could delete). */
export async function deleteReport(d: ProjectDeps, who: Signed, projectId: string, rid: number) {
  await projectFor(d.access, who, projectId, "report:delete", "v1");
  await boundReport(d, projectId, rid);
  const now = d.now();
  await d.store.transaction(async ({ store }) => {
    await store.updateReport(reportId(rid), {
      deleted_at: now.toISOString(),
      date_updated: now.toISOString(),
    });
    await store.cancelScheduledTasks(TASK_GENERATE_REPORT, { report_id: rid }, pythonIso(now));
  });
  return { deleted: true };
}

/** Unschedules; needs report:publish, the policy that schedules (spec H-9). */
export async function cancelSchedule(d: ProjectDeps, who: Signed, projectId: string, rid: number) {
  await projectFor(d.access, who, projectId, "report:publish", "v1");
  const r = await boundReport(d, projectId, rid);
  if (r.status !== "scheduled") throw new BadRequestError("report.not_scheduled");
  const now = d.now();
  await d.store.transaction(async ({ store }) => {
    await store.updateReport(reportId(rid), {
      status: "cancelled",
      date_updated: now.toISOString(),
    });
    await store.cancelScheduledTasks(TASK_GENERATE_REPORT, { report_id: rid }, pythonIso(now));
  });
  return { cancelled: true };
}

export async function reportDetail(d: ProjectDeps, who: Signed, projectId: string, rid: number) {
  await projectFor(d.access, who, projectId, "report:view", "v1");
  return directusRow(await boundReport(d, projectId, rid));
}

/** View counts. A report of another project counts as having none (spec M-11). */
export async function reportViews(d: ProjectDeps, who: Signed, projectId: string, rid: number) {
  await projectFor(d.access, who, projectId, "report:view", "v1");
  if (!(await d.store.reportInProject(reportId(rid), projectId))) return { total: 0, recent: 0 };
  const since = new Date(d.now().getTime() - MIN_LEAD_MS).toISOString();
  return d.store.reportViews(reportId(rid), since);
}

/** Whether a conversation arrived after the report was made (spec M-11 binds the report). */
export async function reportNeedsUpdate(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  rid: number,
) {
  await projectFor(d.access, who, projectId, "report:view", "v1");
  const r = await d.store.reportInProject(reportId(rid), projectId);
  if (!r) return { needs_update: false };
  const latest = await d.store.latestConversationCreatedAt(projectId);
  if (!latest || !r.date_created) return { needs_update: false };
  const at = (s: string) => new Date(s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return { needs_update: at(latest).getTime() > at(r.date_created).getTime() };
}

export async function optedInCount(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "report:view", "v1");
  return { count: await d.store.optedInParticipants(projectId) };
}

/** Where a report stands before any live event: done, failed, or still running. */
export async function reportProgressStart(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  rid: number,
): Promise<"completed" | "failed" | "running"> {
  await projectFor(d.access, who, projectId, "report:view", "v1");
  const r = await d.store.reportInProject(reportId(rid), projectId);
  if (r && (r.status === "archived" || r.status === "published")) return "completed";
  if (r && r.status === "error") return "failed";
  return "running";
}
