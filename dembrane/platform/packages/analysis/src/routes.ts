import type { Access } from "@dembrane/access";
import { NotFoundError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import type { Completer, Embedder } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import * as bff from "./bff";
import { analysisRuntime, type JobSink } from "./runtime";

export interface AnalysisRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly jobs: JobSink;
  readonly completer: Completer;
  readonly embedder: Embedder;
  readonly enablePresent: boolean;
  readonly embeddingModel: string;
  readonly embeddingLocation: string;
  readonly now?: () => Date;
}

const { model, optional, required, nullable, str, int, bool, literal, list, dict } = p;
const BASE = "/api/v2/bff/analysis";

const revisionEditBody = model({
  expected_revision_id: required(str()),
  payload: optional(nullable(dict()), null),
  patch: optional(nullable(dict()), null),
  reason: optional(nullable(str({ max: 1000 })), null),
  change_kind: optional(nullable(str({ max: 16 })), null),
});

/**
 * The analysis BFF: recipes, runs, objects, revisions, last-opened and feedback, lineage.
 * Paths, bodies, status codes and error texts match dembrane.api.v2.bff.analysis.
 */
export function analysisRoutes(deps: AnalysisRoutesDeps) {
  const rt = analysisRuntime({
    db: deps.db,
    logger: deps.logger,
    completer: deps.completer,
    embedder: deps.embedder,
    jobs: deps.jobs,
    config: { embeddingModel: deps.embeddingModel, embeddingLocation: deps.embeddingLocation },
  });
  const d: bff.BffDeps = {
    rt,
    access: deps.access,
    limiter: deps.limiter,
    enablePresent: deps.enablePresent,
    now: deps.now ?? (() => new Date()),
  };
  const app = new Hono<Env>();

  app.get(`${BASE}/recipes`, (c) => {
    requireUser(c);
    return c.json(bff.listRecipesDoc());
  });

  app.post(`${BASE}/projects/:project_id/runs`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        recipe_id: required(str({ min: 1, max: 200 })),
        scope_key: optional(str({ min: 1, max: 200 }), "project"),
        parameters: optional(dict(), {}),
        selected_revision_ids: optional(list(str(), { max: 5000 }), []),
        mode: optional(literal("refresh", "regenerate", "retry"), "refresh"),
        idempotency_key: optional(nullable(str({ min: 8, max: 200 })), null),
        refresh_dependencies: optional(bool(), false),
        retry_run_id: optional(nullable(str()), null),
      }),
    });
    const out = await bff.requestAnalysisRun(d, who, c.req.param("project_id"), body.data);
    return c.json(out, 202);
  });

  app.get(`${BASE}/runs/:run_id`, async (c) => {
    const who = requireUser(c);
    return c.json(await bff.getAnalysisRun(d, who, c.req.param("run_id")));
  });

  app.get(`${BASE}/projects/:project_id/runs`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        offset: optional(int({ ge: 0 }), 0),
        limit: optional(int({ ge: 1, le: bff.MAX_PAGE }), 50),
      },
    });
    return c.json(
      await bff.listAnalysisRuns(d, who, c.req.param("project_id"), query.offset, query.limit),
    );
  });

  app.post(`${BASE}/runs/:run_id/cancel`, async (c) => {
    const who = requireUser(c);
    return c.json(await bff.cancelAnalysisRun(d, who, c.req.param("run_id")));
  });

  app.get(`${BASE}/projects/:project_id/objects`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        type: optional(nullable(str()), null),
        scope: optional(nullable(str()), null),
        snapshot_id: optional(nullable(str()), null),
        membership: optional(literal("active", "withdrawn", "all"), "active"),
        sort: optional(literal("default", "attention"), "default"),
        offset: optional(int({ ge: 0 }), 0),
        limit: optional(int({ ge: 1, le: bff.MAX_PAGE }), 50),
      },
    });
    return c.json(await bff.listAnalysisObjects(d, who, c.req.param("project_id"), query));
  });

  app.get(`${BASE}/projects/:project_id/objects/:object_id/revisions`, async (c) => {
    const who = requireUser(c);
    return c.json(
      await bff.getObjectHistory(d, who, c.req.param("project_id"), c.req.param("object_id")),
    );
  });

  app.post(`${BASE}/projects/:project_id/objects/:object_id/revisions`, async (c) => {
    // The Present flag is a route dependency in the Python: it answers before anything else.
    if (!d.enablePresent) throw new NotFoundError("analysis.feature_disabled");
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: revisionEditBody });
    return c.json(
      await bff.editAnalysisObject(
        d,
        who,
        c.req.param("project_id"),
        c.req.param("object_id"),
        body.data,
      ),
    );
  });

  app.post(`${BASE}/projects/:project_id/objects/:object_id/rollback`, async (c) => {
    if (!d.enablePresent) throw new NotFoundError("analysis.feature_disabled");
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        expected_revision_id: required(str()),
        to_revision_id: required(str()),
        reason: optional(nullable(str({ max: 1000 })), null),
        change_kind: optional(nullable(str({ max: 16 })), null),
      }),
    });
    return c.json(
      await bff.rollbackAnalysisObject(
        d,
        who,
        c.req.param("project_id"),
        c.req.param("object_id"),
        body.data,
      ),
    );
  });

  app.post(`${BASE}/projects/:project_id/objects/:object_id/membership`, async (c) => {
    if (!d.enablePresent) throw new NotFoundError("analysis.feature_disabled");
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        expected_revision_id: required(str()),
        excluded: required(bool()),
        reason: optional(nullable(str({ max: 1000 })), null),
        change_kind: optional(nullable(str({ max: 16 })), null),
      }),
    });
    return c.json(
      await bff.setObjectMembership(
        d,
        who,
        c.req.param("project_id"),
        c.req.param("object_id"),
        body.data,
      ),
    );
  });

  app.get(`${BASE}/projects/:project_id/results/last-opened`, async (c) => {
    const who = requireUser(c);
    return c.json(await bff.getResultsLastOpened(d, who, c.req.param("project_id")));
  });

  app.put(`${BASE}/projects/:project_id/results/last-opened`, async (c) => {
    const who = requireUser(c);
    return c.json(await bff.setResultsLastOpened(d, who, c.req.param("project_id")));
  });

  app.put(`${BASE}/projects/:project_id/objects/:object_id/feedback`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        revision_id: required(str()),
        rating: required(literal("up", "down")),
        tags: optional(list(str(), { max: 4 }), []),
        note: optional(nullable(str({ max: 500 })), null),
      }),
    });
    return c.json(
      await bff.rateAnalysisObject(
        d,
        who,
        c.req.param("project_id"),
        c.req.param("object_id"),
        body.data,
      ),
    );
  });

  app.delete(`${BASE}/projects/:project_id/objects/:object_id/feedback`, async (c) => {
    const who = requireUser(c);
    return c.json(
      await bff.clearAnalysisObjectFeedback(
        d,
        who,
        c.req.param("project_id"),
        c.req.param("object_id"),
      ),
    );
  });

  app.get(`${BASE}/snapshots/:snapshot_id/revisions/:revision_id/lineage`, async (c) => {
    const who = requireUser(c);
    return c.json(
      await bff.getPinnedLineage(d, who, c.req.param("snapshot_id"), c.req.param("revision_id")),
    );
  });

  return app;
}
