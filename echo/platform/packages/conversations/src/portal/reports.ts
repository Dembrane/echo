import { BadRequestError, NotFoundError, newId, PlatformError } from "@dembrane/core";
import type { Env } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";
import { PARTICIPANT_TOKEN_HEADER } from "../participant-token";
import { reportsStorage } from "./reports-storage";

const { model, required, optional, str, int, bool, list, literal } = p;

/** The old unsubscribe route turned every failure, a missing token included, into this. */
class InternalError extends PlatformError {
  readonly status = 500;
  readonly code = "internal";
}

// M-19: subscribing was unlimited; one portal enrols a handful of addresses at most.
const SUBSCRIBE_LIMIT = { name: "participant_report_subscribe", capacity: 20, windowSeconds: 600 };

/** First X-Forwarded-For hop, as the old API took it (spec hole L-20: trusts the header). */
function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  const fwd = c.req.header("x-forwarded-for");
  return fwd ? (fwd.split(",")[0]?.trim() ?? "unknown") : "unknown";
}

const reportId = (id: bigint | number) => Number(id);

/**
 * The portal's published-report pages and report notification sign-up (v1
 * /api/participant/.../report/*). No session: a published report is public by design;
 * subscriptions are bound to the participant's own conversation.
 */
export function publicReportRoutes(d: ConversationsDeps) {
  const store = reportsStorage(d.db);
  const app = new Hono<Env>();

  app.get("/api/participant/:project_id/report/latest", async (c) => {
    const row = await store.latestPublished(c.req.param("project_id"));
    return c.json(
      row
        ? {
            id: reportId(row.id),
            status: row.status,
            project_id: row.project_id,
            show_portal_link: row.show_portal_link,
          }
        : null,
    );
  });

  // Literal paths before the parametrised report route, as FastAPI matched them.
  app.get("/api/participant/:project_id/report/views", async (c) => {
    const since = new Date(d.now().getTime() - 10 * 60_000);
    return c.json({ recent: await store.recentViews(c.req.param("project_id"), since) });
  });

  app.get("/api/participant/report/unsubscribe/eligibility", async (c) => {
    const { query } = await p.validate(c.req, {
      query: { token: required(str()), project_id: required(str()) },
    });
    if (!query.token || !query.project_id)
      throw new BadRequestError("Invalid or missing unsubscribe link.");
    const [row] = await store.subscribersByToken(query.project_id, query.token);
    return c.json({ data: { eligible: Boolean(row?.email_opt_in) } });
  });

  app.get("/api/participant/:project_id/report/:report_id/detail", async (c) => {
    const { path } = await p.validate(c.req, {
      path: { project_id: required(str()), report_id: required(int()) },
    });
    const row = await store.publishedDetail(path.project_id, path.report_id);
    if (!row) throw new NotFoundError("Report not found");
    return c.json({
      id: reportId(row.id),
      content: row.content,
      status: row.status,
      project_id: row.project_id,
      show_portal_link: row.show_portal_link,
    });
  });

  app.post("/api/participant/:project_id/report/metric", async (c) => {
    const { body } = await p.validate(c.req, {
      // L-21: the type was client-set; the portal only ever records views.
      body: model({
        project_report_id: required(int()),
        type: optional(literal("view"), "view"),
      }),
    });
    const projectId = c.req.param("project_id");
    const row = await store.publishedDetail(projectId, body.data.project_report_id);
    if (!row) throw new NotFoundError("Report not found");
    await store.addMetric(body.data.project_report_id, body.data.type, d.now());
    return c.json({ status: "ok" });
  });

  app.post("/api/participant/report/subscribe", async (c) => {
    const { body } = await p.validate(c.req, {
      body: model({
        emails: required(list(str())),
        project_id: required(str()),
        conversation_id: required(str()),
      }),
    });
    const { emails, project_id, conversation_id } = body.data;
    // M-19: the ids were trusted as sent. The conversation must be the participant's own
    // (token when present) and belong to the project; sign-ups are rate limited per IP.
    d.tokens.check(c.req.header(PARTICIPANT_TOKEN_HEADER), conversation_id, project_id);
    await d.limiter.check(SUBSCRIBE_LIMIT, clientIp(c));
    if (!(await store.conversationInProject(project_id, conversation_id)))
      throw new NotFoundError("Conversation not found");
    const failed: string[] = [];
    for (const raw of emails) {
      const email = raw.toLowerCase();
      try {
        const existing = await store.subscriber(email, project_id);
        if (existing?.email_opt_in === true) continue;
        if (existing) await store.deleteSubscriber(existing.id);
        await store.addSubscriber({
          id: newId(),
          email,
          project_id,
          conversation_id,
          email_opt_out_token: crypto.randomUUID(),
          now: d.now(),
        });
      } catch (err) {
        d.logger.error({ err }, "report subscription failed");
        failed.push(email);
      }
    }
    if (failed.length)
      throw new BadRequestError("Some emails failed to process", {
        message: "Some emails failed to process",
        failed,
      });
    return c.json({ status: "success" });
  });

  app.post("/api/participant/:project_id/report/unsubscribe", async (c) => {
    const { body } = await p.validate(c.req, {
      body: model({ token: required(str()), email_opt_in: required(bool()) }),
    });
    const rows = await store.subscribersByToken(c.req.param("project_id"), body.data.token);
    if (!rows.length) throw new InternalError("Internal Server Error");
    for (const r of rows) await store.setOptIn(r.id, body.data.email_opt_in, d.now());
    return c.json({ success: true });
  });

  return app;
}
