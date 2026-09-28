import { type Env, requireUser } from "@echo/http";
import { p } from "@echo/legacy-shape";
import { publish } from "@echo/realtime";
import { type Context, Hono } from "hono";
import type { AgenticRoutesDeps } from "../routes";
import * as svc from "./service";
import { type CanvasDeps, requireCanvasEnabled } from "./service";
import { canvasStorage } from "./storage";

const { model, optional, required, nullable, str, int } = p;

/** The Redis channel name the canvas pages listened on, now a realtime channel. */
export const generationChannel = (reportId: string) => `canvas:generation:${reportId}`;

export function canvasDeps(deps: AgenticRoutesDeps): CanvasDeps {
  const store = canvasStorage(deps.db);
  return {
    store,
    access: deps.access,
    enableCanvas: deps.config.canvas.enabled,
    now: deps.now ?? (() => new Date()),
    publishGeneration: (reportId) =>
      publish(store.sql, generationChannel(reportId), { type: "generation" }, deps.logger),
  };
}

const optionalId = optional(nullable(str()), null);

/**
 * The assistant's canvas routes under /api/agentic/projects/{project_id}. Every one sits
 * behind the canvas beta gate, which answers before authentication, as the FastAPI
 * route dependency did; then the session, then request validation, then chat:use.
 */
export function canvasRoutes(deps: AgenticRoutesDeps) {
  const d = canvasDeps(deps);
  const app = new Hono<Env>();
  const base = "/api/agentic/projects/:project_id";

  /** The canvas gate, then the session, in FastAPI's order; validation follows. */
  const open = async (c: Context<Env>) => {
    await requireCanvasEnabled(d, c.req.param("project_id") ?? "");
    return requireUser(c);
  };

  app.get(`${base}/canvases`, async (c) => {
    const who = await open(c);
    return c.json(await svc.canvases(d, who, c.req.param("project_id"), null));
  });

  app.get(`${base}/chats/:chat_id/canvas-activity`, async (c) => {
    const who = await open(c);
    const input = await p.validate(c.req, { query: { limit: optional(int({ ge: 1 }), 5) } });
    return c.json(
      await svc.canvasActivity(
        d,
        who,
        c.req.param("project_id"),
        c.req.param("chat_id"),
        input.query.limit,
      ),
    );
  });

  app.get(`${base}/canvases/:canvas_id`, async (c) => {
    const who = await open(c);
    return c.json(
      await svc.canvas(d, who, c.req.param("project_id"), null, c.req.param("canvas_id")),
    );
  });

  app.get(`${base}/canvases/:canvas_id/history`, async (c) => {
    const who = await open(c);
    const input = await p.validate(c.req, { query: { limit: optional(int({ ge: 1 }), 30) } });
    return c.json(
      await svc.canvasHistory(
        d,
        who,
        c.req.param("project_id"),
        null,
        c.req.param("canvas_id"),
        input.query.limit,
      ),
    );
  });

  app.post(`${base}/canvases/:canvas_id/edit`, async (c) => {
    const who = await open(c);
    const input = await p.validate(c.req, {
      body: model({
        instruction: required(str({ min: 1 })),
        content_html: required(str({ min: 1 })),
        chat_id: optionalId,
      }),
    });
    const b = input.body.data;
    return c.json(
      await svc.editCanvas(
        d,
        who,
        c.req.param("project_id"),
        b.chat_id,
        c.req.param("canvas_id"),
        b.instruction,
        b.content_html,
      ),
    );
  });

  app.post(`${base}/canvases/:canvas_id/host-items`, async (c) => {
    const who = await open(c);
    const input = await p.validate(c.req, {
      body: model({
        text: required(str({ min: 1, max: 2000 })),
        target_tab: optional(str({ min: 1, max: 80 }), "story"),
        person: optional(nullable(str({ max: 160 })), null),
        chat_id: optionalId,
        message_id: optionalId,
      }),
    });
    const b = input.body.data;
    return c.json(
      await svc.addCanvasHostItem(
        d,
        who,
        c.req.param("project_id"),
        b.chat_id,
        c.req.param("canvas_id"),
        {
          text: b.text,
          target_tab: b.target_tab,
          person: b.person,
          message_id: b.message_id,
        },
      ),
    );
  });

  app.post(`${base}/canvases/:canvas_id/host-items/remove`, async (c) => {
    const who = await open(c);
    const input = await p.validate(c.req, {
      body: model({
        item: required(str({ min: 1, max: 2000 })),
        chat_id: optionalId,
        message_id: optionalId,
      }),
    });
    const b = input.body.data;
    return c.json(
      await svc.removeCanvasHostItem(
        d,
        who,
        c.req.param("project_id"),
        b.chat_id,
        c.req.param("canvas_id"),
        { item: b.item, message_id: b.message_id },
      ),
    );
  });

  app.post(`${base}/canvases/:canvas_id/loop/:action`, async (c) => {
    const who = await open(c);
    return c.json(
      await svc.canvasLoop(
        d,
        who,
        c.req.param("project_id"),
        null,
        c.req.param("canvas_id"),
        c.req.param("action"),
      ),
    );
  });

  return app;
}
