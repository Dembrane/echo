import { type Access, requireStaff, type StaffAudit } from "@dembrane/access";
import { directusTime } from "@dembrane/billing";
import { BadRequestError, ForbiddenError, NotFoundError, newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Env, requireUser, type Signed, v } from "@dembrane/http";
import type { Limit, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import { safeReplayUrl } from "./report";
import { type AdminFilter, type FeedbackRowDb, feedbackStorage } from "./storage";

/**
 * Thumbs up or down on language model output (feedback_responses.py). Generic over
 * target types; only chat messages are rateable today.
 */
const RATING_VALUES = ["up", "down"];
const REASON_KEYS = [
  "incorrect",
  "missed_question",
  "wrong_sources",
  "too_long_or_unclear",
  "wrong_language_or_tone",
  "other",
];
const TARGET_TYPES = ["chat_message", "report", "conversation_summary", "transcript"];
const CHAT_MODES = ["overview", "deep_dive", "agentic"];
const IMPLEMENTED_TARGET_TYPES = ["chat_message"];
const MAX_SNAPSHOT_LENGTH = 20000;
const MAX_PROMPT_LENGTH = 4000;
const MAX_LIST_IDS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResponseDeps {
  readonly db: Db;
  readonly access: Access;
  readonly staffAudit: StaffAudit;
  readonly limiter: RateLimiter;
}

function rowOut(r: FeedbackRowDb) {
  return {
    id: r.id,
    target_type: r.target_type,
    target_id: r.target_id,
    rating: r.rating,
    reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [],
    comment: r.comment ?? null,
    date_created: directusTime(r.date_created),
  };
}

const cut = (s: string, n: number) => [...s].slice(0, n).join("");

/** Python's datetime.fromisoformat after swapping a trailing Z, loosely: date, optional time and offset. */
function isIsoDatetime(s: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}(:\d{2}(:\d{2}(\.\d{1,6})?)?)?)?([+-]\d{2}:?\d{2}|Z)?$/.test(s) &&
    !Number.isNaN(Date.parse(s.replace(" ", "T")))
  );
}

/** Sixty feedback writes per user per minute, as the old limiter allowed. */
export const RESPONSE_LIMIT: Limit = {
  name: "feedback.response",
  capacity: 60,
  windowSeconds: 60,
};

export function responseRoutes(deps: ResponseDeps) {
  const store = feedbackStorage(deps.db);

  /** The message, its chat and the caller's chat:use on the project, with the old 404s. */
  async function resolveChatMessage(who: Signed, targetId: string) {
    const msg = UUID.test(targetId) ? await store.chatMessage(targetId) : null;
    if (!msg?.project_chat_id) throw new NotFoundError("feedback.message_not_found");
    const chat = await store.chat(msg.project_chat_id);
    if (!chat || chat.deleted_at || !chat.project_id) throw new NotFoundError("chat.not_found");
    if (!who.appUserId) throw new ForbiddenError("access.not_onboarded");
    try {
      await deps.access.project(who, chat.project_id, "chat:use");
    } catch (e) {
      // The old resolver answered policy denials with this detail.
      if (e instanceof ForbiddenError && !e.details) throw new ForbiddenError("access.forbidden");
      throw e;
    }
    return { msg, chat };
  }

  return new Hono<Env>()
    .put("/api/v2/feedback/responses", async (c) => {
      const raw = await v.rawRequest(c.req);
      const who = requireUser(c);
      const { body } = v.validateRaw(raw, {
        body: {
          target_type: v.str(),
          target_id: v.str({ min: 1, max: 255 }),
          rating: v.str(),
          reasons: v.withDefault(v.list(v.str()), []),
          comment: v.optional(v.str({ max: 2000 })),
          session_replay_url: v.optional(v.str({ max: 2048 })),
        },
      });
      await deps.limiter.checkUser(RESPONSE_LIMIT, who.directusUserId);
      if (!IMPLEMENTED_TARGET_TYPES.includes(body.target_type))
        throw new BadRequestError("feedback.target_unknown");
      if (!RATING_VALUES.includes(body.rating))
        throw new BadRequestError("feedback.rating_invalid");
      const unknown = body.reasons.find((r) => !REASON_KEYS.includes(r));
      if (unknown !== undefined)
        throw new BadRequestError("feedback.reason_unknown", { params: { reason: unknown } });
      const reasons = body.rating === "up" ? [] : [...new Set(body.reasons)];
      const comment = (body.comment ?? "").trim() || null;

      const { msg, chat } = await resolveChatMessage(who, body.target_id);
      if (String(msg.message_from ?? "").toLowerCase() !== "assistant")
        throw new BadRequestError("feedback.not_assistant_message");
      const context: Record<string, unknown> = {
        project_chat_id: chat.id,
        chat_mode: chat.chat_mode,
      };
      const prompt = await store.precedingUserMessage(chat.id, msg.date_created);
      if (prompt) context.prompt = cut(prompt, MAX_PROMPT_LENGTH);
      const replay = safeReplayUrl(body.session_replay_url);
      const now = new Date().toISOString();

      const patch = { rating: body.rating, reasons, reason: reasons[0] ?? null, comment };
      const existing = await store.ownRow(who.directusUserId, body.target_type, body.target_id);
      let row: FeedbackRowDb;
      if (existing) row = await store.updateFeedback(existing.id, { ...patch, date_updated: now });
      else {
        try {
          row = await store.insertFeedback({
            id: newId(),
            target_type: body.target_type,
            target_id: body.target_id,
            ...patch,
            chat_mode: chat.chat_mode,
            response_snapshot: cut(String(msg.text ?? ""), MAX_SNAPSHOT_LENGTH),
            context: { ...context, ...(replay && { session_replay_url: replay }) },
            project_id: chat.project_id,
            user_id: who.directusUserId,
            date_created: now,
          });
        } catch (err) {
          // Lost a concurrent create on the unique index: update the winner's row.
          const again = await store.ownRow(who.directusUserId, body.target_type, body.target_id);
          if (!again) throw err;
          row = await store.updateFeedback(again.id, { ...patch, date_updated: now });
        }
      }
      return c.json(rowOut(row));
    })
    .get("/api/v2/feedback/responses", async (c) => {
      const raw = await v.rawRequest(c.req);
      const who = requireUser(c);
      const { query } = v.validateRaw(raw, {
        query: { target_type: v.str(), target_ids: v.str() },
      });
      if (!TARGET_TYPES.includes(query.target_type))
        throw new BadRequestError("feedback.target_unknown");
      const ids = query.target_ids
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!ids.length) return c.json([]);
      if (ids.length > MAX_LIST_IDS)
        throw new BadRequestError("feedback.too_many_ids", { params: { max: MAX_LIST_IDS } });
      const rows = await store.ownRows(who.directusUserId, query.target_type, ids, MAX_LIST_IDS);
      return c.json(rows.map(rowOut));
    })
    .get("/api/v2/feedback/responses/admin", async (c) => {
      const raw = await v.rawRequest(c.req);
      const who = requireUser(c);
      const opt = () => v.optional(v.str());
      const { query } = v.validateRaw(raw, {
        query: {
          rating: opt(),
          target_type: opt(),
          reason: opt(),
          chat_mode: opt(),
          date_from: opt(),
          date_to: opt(),
          page: v.withDefault(v.int({ ge: 1 }), 1),
          limit: v.withDefault(v.int({ ge: 1, le: 200 }), 50),
        },
      });
      await requireStaff(deps.staffAudit, who, {
        permission: "staff:feedback",
        action: "feedback.responses.list",
        requestId: c.get("requestId"),
      });
      const f: AdminFilter = {};
      if (query.rating) {
        if (!RATING_VALUES.includes(query.rating))
          throw new BadRequestError("feedback.filter_invalid", { params: { filter: "rating" } });
        f.rating = query.rating;
      }
      if (query.target_type) {
        if (!TARGET_TYPES.includes(query.target_type))
          throw new BadRequestError("feedback.target_unknown");
        f.target_type = query.target_type;
      }
      if (query.reason) {
        if (!REASON_KEYS.includes(query.reason))
          throw new BadRequestError("feedback.filter_invalid", { params: { filter: "reason" } });
        f.reason = query.reason;
      }
      if (query.chat_mode) {
        if (!CHAT_MODES.includes(query.chat_mode))
          throw new BadRequestError("feedback.filter_invalid", { params: { filter: "chat mode" } });
        f.chat_mode = query.chat_mode;
      }
      for (const k of ["date_from", "date_to"] as const) {
        const val = query[k];
        if (!val) continue;
        if (!isIsoDatetime(val.replace(/Z$/, "+00:00")))
          throw new BadRequestError("feedback.date_invalid", { params: { field: k } });
        f[k] = val;
      }
      const { rows, total } = await store.adminPage(f, query.page, query.limit);
      const items = rows.map((r) => ({
        ...rowOut(r.row),
        response_snapshot: r.row.response_snapshot ?? null,
        context:
          r.row.context && typeof r.row.context === "object" && !Array.isArray(r.row.context)
            ? r.row.context
            : {},
        project_id: r.row.project_id ?? null,
        project_name: r.projectName ?? null,
        workspace_id: r.workspaceId ?? r.projectWorkspaceId ?? null,
        workspace_name: r.workspaceName ?? null,
        org_name: r.orgName ?? null,
        user_name: [r.userFirst, r.userLast].filter(Boolean).join(" ") || null,
        user_email: r.userEmail ?? null,
      }));
      return c.json({ items, page: query.page, limit: query.limit, total });
    })
    .delete("/api/v2/feedback/responses/:target_type/:target_id", async (c) => {
      const who = requireUser(c);
      await deps.limiter.checkUser(RESPONSE_LIMIT, who.directusUserId);
      const targetType = c.req.param("target_type");
      if (!TARGET_TYPES.includes(targetType)) throw new BadRequestError("feedback.target_unknown");
      const existing = await store.ownRow(who.directusUserId, targetType, c.req.param("target_id"));
      if (existing) await store.deleteFeedback(existing.id);
      return c.body(null, 204);
    });
}
