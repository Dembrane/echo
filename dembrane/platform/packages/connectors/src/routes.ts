import type { Access } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { type Env, requireUser, v } from "@dembrane/http";
import type { Logger } from "@dembrane/observability";
import type { JobSink } from "@dembrane/queue";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Miro } from "./miro";
import type { Sealer } from "./seal";
import * as svc from "./service";
import { connectorStorage } from "./storage";

export interface ConnectorRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly queue: JobSink;
  readonly logger: Logger;
  readonly miro: Miro | null;
  readonly miroClientId: string | null;
  readonly sealer: Sealer | null;
  readonly stateSecret: string;
  /** The API's public origin; Miro's redirect URI is its callback route. */
  readonly publicUrl: string;
  readonly dashboardUrl: string;
  readonly now?: () => Date;
}

export function connectorDeps(deps: ConnectorRoutesDeps): svc.ConnectorDeps {
  return {
    db: deps.db,
    store: connectorStorage(deps.db),
    access: deps.access,
    jobs: deps.queue,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    miro: deps.miro,
    miroClientId: deps.miroClientId,
    sealer: deps.sealer,
    stateSecret: deps.stateSecret,
    miroRedirectUri: miroRedirectUri(deps.publicUrl),
    dashboardUrl: deps.dashboardUrl,
  };
}

/** Registered as the redirect URI of dembrane's Miro app, one per environment. */
export const miroRedirectUri = (publicUrl: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/connectors/miro/callback`;

const { project } = schema;

/**
 * /api/connectors: a person's links to other apps. /api/projects/{id}/connector-sources:
 * what those links feed into a project. Browsing an app (boards, frames) goes through the
 * caller's own link and needs project:update, like saving a source.
 */
export function connectorRoutes(deps: ConnectorRoutesDeps) {
  const d = connectorDeps(deps);
  const app = new Hono<Env>();
  const base = "/api/projects/:project_id/connector-sources";

  app.get("/api/connectors", async (c) => c.json(await svc.providers(d, requireUser(c))));

  app.get("/api/projects/:project_id/connectors/:provider/authorize", async (c) =>
    c.json(
      await svc.authorizeUrl(d, requireUser(c), c.req.param("project_id"), c.req.param("provider")),
    ),
  );

  // The browser lands here from the app's sign-in page; it always leaves with a redirect.
  app.get("/api/connectors/:provider/callback", async (c) => {
    const target = await svc.completeAuthorization(
      d,
      c.get("principal"),
      c.req.param("provider"),
      { code: c.req.query("code"), state: c.req.query("state"), error: c.req.query("error") },
      async (projectId) => {
        const [row] = await deps.db
          .select({ workspace: project.workspace_id })
          .from(project)
          .where(eq(project.id, projectId))
          .limit(1);
        return row?.workspace ? `/w/${row.workspace}/projects/${projectId}` : null;
      },
    );
    return c.redirect(target, 302);
  });

  app.delete("/api/connectors/:provider", async (c) => {
    await svc.disconnect(d, requireUser(c), c.req.param("provider"));
    return c.body(null, 204);
  });

  app.get("/api/projects/:project_id/connectors/miro/boards", async (c) =>
    c.json(
      await svc.boards(d, requireUser(c), c.req.param("project_id"), c.req.query("query") ?? null),
    ),
  );

  app.get("/api/projects/:project_id/connectors/miro/boards/:board_id/frames", async (c) =>
    c.json(await svc.frames(d, requireUser(c), c.req.param("project_id"), c.req.param("board_id"))),
  );

  app.get(base, async (c) =>
    c.json(await svc.listSources(d, requireUser(c), c.req.param("project_id"))),
  );

  app.post(base, async (c) => {
    const who = requireUser(c);
    const { body } = await v.validate(c, {
      body: {
        provider: v.str({ min: 1, max: 32 }),
        board: v.str({ min: 1, max: 500 }),
        frame_ids: v.list(v.str({ min: 1, max: 255 }), { min: 1 }),
        voice: v.withDefault(v.str({ max: 32 }), "organisers"),
      },
    });
    return c.json(await svc.createSource(d, who, c.req.param("project_id"), body), 201);
  });

  app.patch(`${base}/:source_id`, async (c) => {
    const who = requireUser(c);
    const { body } = await v.validate(c, {
      body: {
        frame_ids: v.optional(v.list(v.str({ min: 1, max: 255 }))),
        voice: v.optional(v.str({ max: 32 })),
      },
    });
    return c.json(
      await svc.updateSource(d, who, c.req.param("project_id"), c.req.param("source_id"), body),
    );
  });

  app.post(`${base}/:source_id/sync`, async (c) =>
    c.json(
      await svc.requestSync(d, requireUser(c), c.req.param("project_id"), c.req.param("source_id")),
      202,
    ),
  );

  app.delete(`${base}/:source_id`, async (c) => {
    await svc.deleteSource(d, requireUser(c), c.req.param("project_id"), c.req.param("source_id"));
    return c.body(null, 204);
  });

  return app;
}
