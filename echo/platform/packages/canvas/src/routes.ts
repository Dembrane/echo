import { type Access, DrizzleAccessStore } from "@echo/access";
import type { Db } from "@echo/db";
import { type Env, requireUser } from "@echo/http";
import { p } from "@echo/legacy-shape";
import type { Completer } from "@echo/llm";
import type { Logger } from "@echo/observability";
import type { EnqueueOptions, JobDefinition, Payload } from "@echo/queue";
import { PostgresRateCounter, RateLimiter } from "@echo/ratelimit";
import { Hono } from "hono";
import { requireCanvasEnabled } from "./access";
import { canvasEventStream, publishGenerationNudge } from "./events";
import { canvasTick } from "./jobs";
import * as svc from "./service";
import { canvasStore, client } from "./storage";
import { datetime } from "./validate";

export interface JobSink {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: EnqueueOptions,
  ): Promise<string | null>;
}

export interface CanvasRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly queue: JobSink;
  readonly logger: Logger;
  readonly completer: Completer;
  /** config.canvas.enabled: off answers every canvas route with 404. */
  readonly canvasEnabled: boolean;
  readonly limiter?: RateLimiter;
  readonly now?: () => Date;
}

const { model, optional, required, nullable, str, int, list, dict } = p;

/**
 * Dynamic canvases: /api/v2/bff/canvases. Paths, bodies, error texts and live frames match
 * the Python BFF; a manual refresh runs its tick on the worker instead of inside the
 * request, and a preview names itself after the project.
 */
export function canvasRoutes(deps: CanvasRoutesDeps) {
  const sql = client(deps.db);
  const store = canvasStore(sql);
  const d: svc.CanvasDeps = {
    access: deps.access,
    accessStore: new DrizzleAccessStore(deps.db),
    store,
    canvasEnabled: deps.canvasEnabled,
    completer: deps.completer,
    limiter: deps.limiter ?? new RateLimiter(new PostgresRateCounter(deps.db)),
    now: deps.now ?? (() => new Date()),
    startTick: async (loopId, tickKind) => {
      await deps.queue.enqueue(canvasTick, { loopId, tickKind });
    },
    nudge: (reportId) => publishGenerationNudge(sql, reportId, deps.logger),
  };
  const app = new Hono<Env>();
  const base = "/api/v2/bff/canvases";
  const canvasPath = { canvas_id: required(str()) };

  // The global flag is a router dependency in the Python app: it answers before sign-in.
  app.use(`${base}/*`, async (_c, next) => {
    requireCanvasEnabled(d);
    await next();
  });
  app.use(base, async (_c, next) => {
    requireCanvasEnabled(d);
    await next();
  });

  const createBody = model({
    project_id: required(str()),
    name: required(str({ min: 1, max: 160 })),
    brief: required(str({ min: 1, max: 8000 })),
    gather_spec: optional(nullable(dict()), null),
    cadence_minutes: optional(int({ ge: 2, le: 120 }), 5),
    expires_at: required(datetime()),
    created_from_chat_id: optional(nullable(str()), null),
    applied_preview_html: optional(nullable(str({ min: 1 })), null),
    tabs: optional(nullable(list(dict())), null),
  });
  const updateBody = model({
    name: required(str({ min: 1, max: 160 })),
    brief: required(str({ min: 1, max: 8000 })),
    gather_spec: optional(nullable(dict()), null),
    cadence_minutes: optional(int({ ge: 2, le: 120 }), 5),
    created_from_chat_id: optional(nullable(str()), null),
    applied_preview_html: optional(nullable(str({ min: 1 })), null),
    tabs: optional(nullable(list(dict())), null),
  });

  app.get(base, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: { project_id: required(str({ min: 1 })) } });
    return c.json(await svc.listCanvases(d, who, query.project_id));
  });

  app.post(base, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: createBody });
    return c.json(await svc.createCanvas(d, who, body.data));
  });

  app.post(`${base}/preview`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        project_id: required(str()),
        brief: required(str({ min: 1, max: 8000 })),
        gather_spec: optional(nullable(dict()), null),
        tabs: optional(nullable(list(dict())), null),
      }),
    });
    return c.json(await svc.previewCanvas(d, who, body.data));
  });

  app.get(`${base}/:canvas_id`, async (c) => {
    const who = requireUser(c);
    return c.json(await svc.getCanvas(d, who, c.req.param("canvas_id")));
  });

  app.get(`${base}/:canvas_id/events`, async (c) => {
    const who = requireUser(c);
    const reportId = await svc.canvasForEvents(d, who, c.req.param("canvas_id"));
    return canvasEventStream(c, {
      sql,
      logger: deps.logger,
      reportId,
      latestGenerationId: () => svc.latestGenerationId(d, reportId),
    });
  });

  app.patch(`${base}/:canvas_id`, async (c) => {
    const who = requireUser(c);
    const { path, body } = await p.validate(c.req, { path: canvasPath, body: updateBody });
    return c.json(await svc.updateCanvas(d, who, path.canvas_id, body.data));
  });

  app.get(`${base}/:canvas_id/generations`, async (c) => {
    const who = requireUser(c);
    const { path, query } = await p.validate(c.req, {
      path: canvasPath,
      query: { limit: optional(int({ ge: 1, le: 50 }), 8) },
    });
    return c.json(await svc.listGenerations(d, who, path.canvas_id, query.limit));
  });

  app.post(`${base}/:canvas_id/refresh`, async (c) => {
    const who = requireUser(c);
    return c.json(await svc.refreshCanvas(d, who, c.req.param("canvas_id")), 202);
  });

  app.post(`${base}/:canvas_id/host-items`, async (c) => {
    const who = requireUser(c);
    const { path, body } = await p.validate(c.req, {
      path: canvasPath,
      body: model({
        text: required(str({ min: 1, max: 2000 })),
        target_tab: optional(str({ min: 1, max: 80 }), "story"),
        person: optional(nullable(str({ max: 160 })), null),
        chat_id: optional(nullable(str()), null),
        message_id: optional(nullable(str()), null),
      }),
    });
    return c.json(await svc.addHostItem(d, who, path.canvas_id, body.data));
  });

  app.post(`${base}/:canvas_id/host-items/remove`, async (c) => {
    const who = requireUser(c);
    const { path, body } = await p.validate(c.req, {
      path: canvasPath,
      body: model({
        item: required(str({ min: 1, max: 2000 })),
        chat_id: optional(nullable(str()), null),
        message_id: optional(nullable(str()), null),
      }),
    });
    return c.json(await svc.removeHostItemRoute(d, who, path.canvas_id, body.data));
  });

  app.post(`${base}/:canvas_id/loop/:action`, async (c) => {
    const who = requireUser(c);
    const action = c.req.param("action");
    if (!["pause", "resume", "stop"].includes(action))
      return c.json({ detail: "Canvas loop action not found" }, 404);
    return c.json(await svc.loopAction(d, who, c.req.param("canvas_id"), action));
  });

  app.patch(`${base}/:canvas_id/loop`, async (c) => {
    const who = requireUser(c);
    const { path, body } = await p.validate(c.req, {
      path: canvasPath,
      body: model({
        cadence_minutes: required(int({ ge: 2, le: 120 })),
        expires_at: required(datetime()),
      }),
    });
    return c.json(await svc.patchLoop(d, who, path.canvas_id, body.data));
  });

  return app;
}
