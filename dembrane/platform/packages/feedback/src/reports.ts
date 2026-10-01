import {
  type Access,
  DrizzleAccessStore,
  type Principal,
  requireStaff,
  resolveProject,
  resolveWorkspace,
  type StaffAudit,
} from "@dembrane/access";
import {
  BadRequestError,
  NotFoundError,
  newId,
  StatusError,
  ValidationError,
} from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Env, requireUser, v } from "@dembrane/http";
import type { Limit, RateLimiter } from "@dembrane/ratelimit";
import type { ObjectStorage } from "@dembrane/storage";
import { Hono } from "hono";
import {
  ALLOWED_IMAGE_TYPES,
  ATTACHMENT_URL_TTL_SECONDS,
  attachmentLinkBase,
  buildReportMessage,
  buildReportPageContext,
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  PREVIEW_URL_TTL_SECONDS,
  safeFilename,
  safeRelatedId,
} from "./report";
import { type FeedbackStore, feedbackStorage } from "./storage";

export interface ReportDeps {
  readonly db: Db;
  readonly access: Access;
  readonly staffAudit: StaffAudit;
  readonly limiter: RateLimiter;
  readonly storage: ObjectStorage;
  /** Public API base, for the staff links to attachments. */
  readonly apiBaseUrl: string;
  /** Test seam; defaults to Postgres. */
  readonly store?: Pick<FeedbackStore, "directusProfile" | "insertSupportRequest">;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keeps only scope ids the caller can reach and drops both on any doubt: the workspace
 * of a project comes off the project row, never from the client. Project reach needs
 * project:read (spec 8 Q2: workspace billing users reach no project).
 */
async function resolveScope(
  db: Db,
  who: Principal,
  workspaceId: string | null,
  projectId: string | null,
): Promise<[string | null, string | null]> {
  const pid = safeRelatedId(projectId);
  const wid = safeRelatedId(workspaceId);
  if (!pid && !wid) return [null, null];
  try {
    const store = new DrizzleAccessStore(db);
    if (pid) {
      const access = UUID.test(pid) ? await resolveProject(store, pid, who, new Date()) : null;
      return access ? [safeRelatedId(access.project.workspaceId), pid] : [null, null];
    }
    if (wid && who.appUserId && UUID.test(wid)) {
      if (await resolveWorkspace(store, wid, who, new Date())) return [wid, null];
    }
  } catch {
    // A database hiccup costs the scope ids, never the report.
  }
  return [null, null];
}

function formString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return formString(v.at(-1));
  return null;
}

/** POST /api/v2/feedback/reports and the staff attachment link. */
/** Five reports per user in ten minutes, as the old limiter allowed. */
export const REPORT_LIMIT: Limit = { name: "feedback.report", capacity: 5, windowSeconds: 600 };

export function reportRoutes(deps: ReportDeps) {
  const store = deps.store ?? feedbackStorage(deps.db);
  return new Hono<Env>()
    .post("/api/v2/feedback/reports", async (c) => {
      const who = requireUser(c);
      const type = c.req.header("content-type") ?? "";
      const form =
        type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")
          ? await c.req.parseBody({ all: true })
          : {};
      const rawMessage = formString(form.message);
      if (rawMessage === null) {
        const issues = [
          {
            type: "missing",
            loc: ["body", "message"],
            msg: "Field required",
            input: null,
            url: "https://errors.pydantic.dev/2.12/v/missing",
          },
        ];
        throw new ValidationError("validation.invalid_input", {
          details: issues,
          params: { fields: v.fieldProblems(issues) },
        });
      }
      const rawFiles = form.attachments;
      const files = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []).filter(
        (f): f is File => f instanceof File,
      );

      const message = rawMessage.trim();
      if (!message) throw new BadRequestError("feedback.message_required");
      if (message.length > MAX_MESSAGE_LENGTH)
        throw new BadRequestError("feedback.message_too_long");
      if (files.length > MAX_ATTACHMENTS)
        throw new BadRequestError("feedback.too_many_attachments", {
          params: { max: MAX_ATTACHMENTS },
        });
      for (const f of files) {
        if (!ALLOWED_IMAGE_TYPES.has(f.type))
          throw new BadRequestError("upload.unsupported_type", {
            message: "Only image attachments.",
            params: { accepted: "image", content_type: f.type },
          });
        if (f.size > MAX_ATTACHMENT_MB * 1024 * 1024)
          throw new BadRequestError("upload.too_large", {
            message: `Images must be under ${MAX_ATTACHMENT_MB}MB.`,
            params: { max_mb: MAX_ATTACHMENT_MB },
          });
      }
      // After validation: a malformed request must not spend rate-limit budget.
      await deps.limiter.checkUser(REPORT_LIMIT, who.directusUserId);

      const [workspaceId, projectId] = await resolveScope(
        deps.db,
        who,
        formString(form.workspace_id),
        formString(form.project_id),
      );
      const profile = await store.directusProfile(who.directusUserId);
      const email = profile?.email || "unknown";
      const name =
        `${profile?.first ?? ""} ${profile?.last ?? ""}`.trim() || profile?.email || "unknown";

      const reportId = newId();
      const stored: string[] = [];
      const links: [string, string][] = [];
      const apiBase = attachmentLinkBase(deps.apiBaseUrl);
      const supportRequestId = newId();
      try {
        for (const [i, f] of files.entries()) {
          const filename = `${i}-${safeFilename(f.name)}`;
          const key = `feedback/${reportId}/${filename}`;
          await deps.storage.put(key, await f.arrayBuffer(), f.type);
          stored.push(key);
          links.push([
            deps.storage.presignDownload(key, { expiresInSeconds: PREVIEW_URL_TTL_SECONDS }),
            `${apiBase}/api/v2/feedback/attachments/${reportId}/${filename}`,
          ]);
        }
        try {
          await store.insertSupportRequest({
            id: supportRequestId,
            created_at: new Date().toISOString(),
            source: "dashboard",
            directus_user_id: who.directusUserId,
            app_user_id: null,
            workspace_id: workspaceId,
            project_id: projectId,
            chat_id: null,
            message_id: null,
            message: buildReportMessage({
              reporterName: name,
              reporterEmail: email,
              message,
              sessionReplayUrl: formString(form.session_replay_url),
              attachmentLinks: links,
            }),
            page_context: buildReportPageContext({
              pageUrl: formString(form.page_url),
              locale: formString(form.locale),
              userAgent: formString(form.user_agent),
            }),
            status: "new",
          });
        } catch (err) {
          c.get("logger")?.error({ err, reportId }, "support request create failed");
          throw new StatusError(502, "feedback.save_failed");
        }
      } catch (err) {
        // No partial success: stored images go when the report does not land.
        for (const key of stored) await deps.storage.delete(key).catch(() => {});
        throw err;
      }
      return c.json(
        {
          report_id: reportId,
          support_request_id: supportRequestId,
          attachment_count: stored.length,
        },
        201,
      );
    })
    .get("/api/v2/feedback/attachments/:report_id/:filename", async (c) => {
      const who = requireUser(c);
      const reportId = c.req.param("report_id");
      const filename = c.req.param("filename");
      await requireStaff(
        deps.staffAudit,
        who,
        {
          permission: "staff:feedback",
          action: "feedback.attachment.read",
          targetType: "feedback_report",
          targetId: reportId,
          detail: { filename },
          requestId: c.get("requestId"),
        },
        "Staff only.",
      );
      if ([reportId, filename].some((s) => s.includes("/") || s.includes("..")))
        throw new BadRequestError("feedback.attachment_path_invalid");
      const key = `feedback/${reportId}/${filename}`;
      let exists = false;
      try {
        exists = (await deps.storage.size(key)) !== null;
      } catch (err) {
        c.get("logger")?.warn({ err, key }, "attachment head failed");
      }
      if (!exists) throw new NotFoundError("feedback.attachment_not_found");
      return c.redirect(
        deps.storage.presignDownload(key, { expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS }),
        307,
      );
    });
}
