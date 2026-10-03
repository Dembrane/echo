import type { Access } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import { type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import type { JobSink } from "@dembrane/queue";
import { boundedEventStream } from "@dembrane/realtime";
import { Hono } from "hono";
import * as goals from "./goals";
import { progressStream } from "./progress";
import * as projects from "./projects";
import { PROJECT_UPDATE_FIELDS, type ProjectDeps } from "./projects";
import * as reports from "./reports";
import { projectsStorage } from "./storage";
import * as tags from "./tags";
import * as templates from "./templates";

export interface ProjectRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly queue: JobSink;
  readonly now?: () => Date;
  /**
   * Called when a signed-in person loads a project in the dashboard, after the access
   * check: customer accounts mark "Check out the demo" done. Not awaited, so it never
   * slows the page; it must never throw.
   */
  readonly onProjectOpened?: (projectId: string, appUserId: string | null) => Promise<void>;
  /**
   * Called once a clone has committed: customer accounts mark "Create a project" done. It
   * must never throw; the project exists.
   */
  readonly onProjectCreated?: (projectId: string) => Promise<void>;
}

const { model, nested, optional, required, nullable, str, int, bool, literal, list, dict, any } = p;

const projectPath = { project_id: required(str()) };
const reportPath = { project_id: required(str()), report_id: required(int()) };

const updateShape = Object.fromEntries(
  PROJECT_UPDATE_FIELDS.map((f) => {
    const kind =
      f === "host_guide"
        ? dict()
        : f === "legal_basis"
          ? literal("client-managed", "consent", "dembrane-events")
          : f.startsWith("is_") ||
              f.startsWith("default_conversation_ask") ||
              f === "anonymize_transcripts" ||
              f === "enable_ai_title_and_tags"
            ? bool()
            : str();
    return [f, optional(nullable(kind as p.Type<unknown>), null)];
  }),
);

/**
 * Projects, reports, tags, goals, methodologies and prompt templates: the v1 /api/projects
 * and /api/templates routes, v2 /api/v2/projects, and the BFF tag, project, goal and
 * methodology routes.
 * Paths, bodies and error texts of ported routes match the Python API.
 */
export function projectRoutes(deps: ProjectRoutesDeps) {
  const d: ProjectDeps = {
    store: projectsStorage(deps.db),
    access: deps.access,
    jobs: deps.queue,
    now: deps.now ?? (() => new Date()),
  };
  const app = new Hono<Env>();

  // ── v1 /api/projects ──────────────────────────────────────────────

  app.patch("/api/projects/:project_id/pin", async (c) => {
    const who = requireUser(c);
    const { path, body } = await p.validate(c.req, {
      path: projectPath,
      body: model({ pin_order: optional(nullable(int()), null) }),
    });
    return c.json(await projects.pinProject(d, who, path.project_id, body.data.pin_order));
  });

  app.delete("/api/projects/:project_id", async (c) => {
    const who = requireUser(c);
    return c.json(await projects.deleteProjectV1(d, who, c.req.param("project_id")));
  });

  app.delete("/api/projects/:project_id/tags/:tag_id", async (c) => {
    const who = requireUser(c);
    return c.json(
      await tags.deleteProjectTag(d, who, c.req.param("project_id"), c.req.param("tag_id")),
    );
  });

  app.get("/api/projects/:project_id/transcripts", async (c) => {
    const who = requireUser(c);
    const out = await projects.exportTranscripts(d, who, c.req.param("project_id"));
    return c.body(out.body as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${out.filename}"`,
    });
  });

  app.post("/api/projects/:project_id/create-report", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        language: optional(nullable(str()), "en"),
        user_instructions: optional(nullable(str()), null),
        scheduled_at: optional(nullable(str()), null),
      }),
    });
    return c.json(await reports.createReport(d, who, c.req.param("project_id"), body.data), 202);
  });

  app.get("/api/projects/:project_id/reports", async (c) => {
    const who = requireUser(c);
    return c.json(await reports.listReports(d, who, c.req.param("project_id")));
  });

  app.get("/api/projects/:project_id/reports/latest", async (c) => {
    const who = requireUser(c);
    return c.json(await reports.latestReport(d, who, c.req.param("project_id")));
  });

  app.patch("/api/projects/:project_id/reports/:report_id", async (c) => {
    const who = requireUser(c);
    const { path, body } = await p.validate(c.req, {
      path: reportPath,
      body: model({
        status: optional(nullable(str()), null),
        show_portal_link: optional(nullable(bool()), null),
        content: optional(nullable(str()), null),
        scheduled_at: optional(nullable(str()), null),
      }),
    });
    return c.json(await reports.updateReport(d, who, path.project_id, path.report_id, body.data));
  });

  app.delete("/api/projects/:project_id/reports/:report_id", async (c) => {
    const who = requireUser(c);
    const { path } = await p.validate(c.req, { path: reportPath });
    return c.json(await reports.deleteReport(d, who, path.project_id, path.report_id));
  });

  app.post("/api/projects/:project_id/reports/:report_id/cancel-schedule", async (c) => {
    const who = requireUser(c);
    const { path } = await p.validate(c.req, { path: reportPath });
    return c.json(await reports.cancelSchedule(d, who, path.project_id, path.report_id));
  });

  app.get("/api/projects/:project_id/reports/:report_id/detail", async (c) => {
    const who = requireUser(c);
    const { path } = await p.validate(c.req, { path: reportPath });
    return c.json(await reports.reportDetail(d, who, path.project_id, path.report_id));
  });

  app.get("/api/projects/:project_id/reports/:report_id/views", async (c) => {
    const who = requireUser(c);
    const { path } = await p.validate(c.req, { path: reportPath });
    return c.json(await reports.reportViews(d, who, path.project_id, path.report_id));
  });

  app.get("/api/projects/:project_id/reports/:report_id/needs-update", async (c) => {
    const who = requireUser(c);
    const { path } = await p.validate(c.req, { path: reportPath });
    return c.json(await reports.reportNeedsUpdate(d, who, path.project_id, path.report_id));
  });

  app.get("/api/projects/:project_id/participants/count", async (c) => {
    const who = requireUser(c);
    return c.json(await reports.optedInCount(d, who, c.req.param("project_id")));
  });

  app.get("/api/projects/:project_id/reports/:report_id/progress", async (c) => {
    const who = requireUser(c);
    const { path } = await p.validate(c.req, { path: reportPath });
    const start = await reports.reportProgressStart(d, who, path.project_id, path.report_id);
    const body = boundedEventStream(
      (signal) => progressStream(deps.db, path.report_id, start, signal),
      { signal: c.req.raw.signal },
    );
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  app.post("/api/projects/:project_id/clone", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        name: optional(nullable(str()), null),
        language: optional(nullable(str()), null),
      }),
    });
    const id = await projects.cloneProject(d, who, c.req.param("project_id"), body.data);
    await deps.onProjectCreated?.(id);
    return c.json(id);
  });

  // ── v2 /api/v2/projects ───────────────────────────────────────────

  app.post("/api/v2/projects/bulk-move", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        project_ids: required(list(str())),
        target_workspace_id: required(str()),
      }),
    });
    return c.json(
      await projects.bulkMoveProjects(d, who, body.data.project_ids, body.data.target_workspace_id),
    );
  });

  app.get("/api/v2/projects/:project_id", async (c) => {
    const who = requireUser(c);
    return c.json(await projects.projectDetail(d, who, c.req.param("project_id")));
  });

  app.get("/api/v2/projects/:project_id/bff", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        include_tags: optional(bool(), true),
        include_legal: optional(bool(), false),
        fields: optional(nullable(str()), null),
      },
    });
    const out = await projects.projectBff(d, who, c.req.param("project_id"), {
      includeTags: query.include_tags,
      includeLegal: query.include_legal,
      fields: query.fields,
    });
    void deps.onProjectOpened?.(c.req.param("project_id"), who.appUserId);
    return c.json(out);
  });

  app.post("/api/v2/projects/:project_id/move", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ target_workspace_id: required(str()) }),
    });
    return c.json(
      await projects.moveProject(d, who, c.req.param("project_id"), body.data.target_workspace_id),
    );
  });

  app.patch("/api/v2/projects/:project_id/visibility", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ visibility: required(literal("workspace", "private")) }),
    });
    return c.json(
      await projects.setVisibility(d, who, c.req.param("project_id"), body.data.visibility),
    );
  });

  app.get("/api/v2/projects/:project_id/conversation-usage", async (c) => {
    const who = requireUser(c);
    return c.json(await projects.conversationUsage(d, who, c.req.param("project_id")));
  });

  // ── BFF tags and projects ─────────────────────────────────────────

  app.get("/api/v2/bff/tags", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: { project_id: required(str()) } });
    return c.json(await tags.listTags(d, who, query.project_id));
  });

  app.post("/api/v2/bff/tags", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        project_id: required(str()),
        text: required(str()),
        sort: optional(nullable(int()), null),
      }),
    });
    return c.json(await tags.createTag(d, who, body.data));
  });

  app.patch("/api/v2/bff/tags/:tag_id", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        text: optional(nullable(str()), null),
        sort: optional(nullable(int()), null),
      }),
    });
    return c.json(await tags.updateTag(d, who, c.req.param("tag_id"), body.data));
  });

  app.get("/api/v2/bff/projects", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        limit: optional(int({ ge: 1, le: 1000 }), 1000),
        offset: optional(int({ ge: 0 }), 0),
        search: optional(nullable(str()), null),
        workspace_id: optional(nullable(str()), null),
      },
    });
    const { workspace_id: workspaceId, ...rest } = query;
    return c.json(await projects.listMyProjects(d, who, { ...rest, workspaceId }));
  });

  app.patch("/api/v2/bff/projects/:project_id", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: model(updateShape) });
    return c.json(
      await projects.updateProject(d, who, c.req.param("project_id"), body.data, body.fieldsSet),
    );
  });

  // ── BFF goals and methodologies ───────────────────────────────────

  app.get("/api/v2/bff/projects/:project_id/goal", async (c) => {
    const who = requireUser(c);
    return c.json(await goals.getGoal(d, who, c.req.param("project_id")));
  });

  app.post("/api/v2/bff/projects/:project_id/goal", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        content: required(str({ min: 1 })),
        chat_id: optional(nullable(str()), null),
        set_by: optional(literal("host-edit", "interview"), "host-edit"),
      }),
    });
    return c.json(await goals.setGoal(d, who, c.req.param("project_id"), body.data));
  });

  app.get("/api/v2/bff/methodologies", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { workspace_id: required(str({ min: 1 })) },
    });
    return c.json(await goals.listMethodologies(d, who, query.workspace_id));
  });

  app.post("/api/v2/bff/methodologies", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        workspace_id: required(str({ min: 1 })),
        name: required(str({ min: 1 })),
        description: required(str({ min: 1 })),
        framing: required(str({ min: 1 })),
        content: optional(any(), null),
      }),
    });
    return c.json(await goals.createMethodology(d, who, body.data));
  });

  app.get("/api/v2/bff/methodologies/:methodology_id", async (c) => {
    const who = requireUser(c);
    return c.json(await goals.getMethodology(d, who, c.req.param("methodology_id")));
  });

  app.post("/api/v2/bff/methodologies/:methodology_id/versions", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        name: optional(nullable(str()), null),
        description: optional(nullable(str()), null),
        framing: optional(nullable(str()), null),
        content: optional(any(), null),
        note: optional(nullable(str()), null),
      }),
    });
    return c.json(
      await goals.editMethodology(d, who, c.req.param("methodology_id"), body.data, body.fieldsSet),
    );
  });

  // ── v1 /api/templates ─────────────────────────────────────────────

  app.get("/api/templates/prompt-templates", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { workspace_id: optional(nullable(str()), null) },
    });
    return c.json(await templates.listTemplates(d, who, query.workspace_id));
  });

  app.post("/api/templates/prompt-templates", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        title: required(str({ max: 200 })),
        content: required(str()),
        icon: optional(nullable(str({ max: 50 })), null),
        scope: optional(literal("user", "workspace"), "user"),
        workspace_id: optional(nullable(str()), null),
      }),
    });
    return c.json(await templates.createTemplate(d, who, body.data));
  });

  app.patch("/api/templates/prompt-templates/:template_id", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        title: optional(nullable(str({ max: 200 })), null),
        content: optional(nullable(str()), null),
        icon: optional(nullable(str({ max: 50 })), null),
      }),
    });
    return c.json(await templates.updateTemplate(d, who, c.req.param("template_id"), body.data));
  });

  app.delete("/api/templates/prompt-templates/:template_id", async (c) => {
    const who = requireUser(c);
    return c.json(await templates.deleteTemplate(d, who, c.req.param("template_id")));
  });

  app.get("/api/templates/quick-access", async (c) => {
    const who = requireUser(c);
    return c.json(await templates.getQuickAccess(d, who));
  });

  app.put("/api/templates/quick-access", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: list(nested(model({ type: required(literal("static", "user")), id: required(str()) }))),
    });
    return c.json(await templates.saveQuickAccess(d, who, body));
  });

  app.patch("/api/templates/ai-suggestions", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ hide_ai_suggestions: required(bool()) }),
    });
    return c.json(await templates.setHideAiSuggestions(d, who, body.data.hide_ai_suggestions));
  });

  return app;
}
