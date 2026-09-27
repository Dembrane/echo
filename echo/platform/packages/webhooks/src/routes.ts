import type { Access } from "@echo/access";
import type { Db } from "@echo/db";
import { type Env, requireUser } from "@echo/http";
import { p } from "@echo/legacy-shape";
import type { JobSink } from "@echo/projects";
import { Hono } from "hono";
import type { Deliver } from "./deliver";
import * as svc from "./service";
import { webhooksStorage } from "./storage";

export interface WebhookRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly queue: JobSink;
  readonly deliver: Deliver;
  readonly allowPrivateTargets: boolean;
  readonly dashboardUrl: string;
  readonly now?: () => Date;
}

const { model, optional, required, nullable, str, list } = p;

/** /api/projects/{id}/webhooks: a project's outbound webhook settings and the test button. */
export function webhookRoutes(deps: WebhookRoutesDeps) {
  const d: svc.WebhookDeps = {
    store: webhooksStorage(deps.db),
    access: deps.access,
    jobs: deps.queue,
    deliver: deps.deliver,
    now: deps.now ?? (() => new Date()),
    enabled: true,
    allowPrivateTargets: deps.allowPrivateTargets,
    dashboardUrl: deps.dashboardUrl,
  };
  const base = "/api/projects/:project_id/webhooks";
  const app = new Hono<Env>();

  app.get(base, async (c) => {
    const who = requireUser(c);
    return c.json(await svc.listWebhooks(d, who, c.req.param("project_id")));
  });

  app.get(`${base}/copyable`, async (c) => {
    const who = requireUser(c);
    return c.json(await svc.copyableWebhooks(d, who, c.req.param("project_id")));
  });

  app.post(base, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        name: required(str()),
        url: required(str()),
        secret: optional(nullable(str()), null),
        events: required(list(str())),
      }),
    });
    return c.json(await svc.createWebhook(d, who, c.req.param("project_id"), body.data), 201);
  });

  app.patch(`${base}/:webhook_id`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        name: optional(nullable(str()), null),
        url: optional(nullable(str()), null),
        secret: optional(nullable(str()), null),
        events: optional(nullable(list(str())), null),
        status: optional(nullable(str()), null),
      }),
    });
    return c.json(
      await svc.updateWebhook(
        d,
        who,
        c.req.param("project_id"),
        c.req.param("webhook_id"),
        body.data,
      ),
    );
  });

  app.delete(`${base}/:webhook_id`, async (c) => {
    const who = requireUser(c);
    await svc.deleteWebhook(d, who, c.req.param("project_id"), c.req.param("webhook_id"));
    return c.body(null, 204);
  });

  app.post(`${base}/:webhook_id/test`, async (c) => {
    const who = requireUser(c);
    return c.json(
      await svc.testWebhook(d, who, c.req.param("project_id"), c.req.param("webhook_id")),
    );
  });

  return app;
}
