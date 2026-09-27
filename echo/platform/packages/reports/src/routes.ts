import type { Access } from "@echo/access";
import type { Db } from "@echo/db";
import { type Env, requireUser } from "@echo/http";
import { p } from "@echo/legacy-shape";
import { Hono } from "hono";
import * as reports from "./service";
import { reportsStorage } from "./storage";

export interface ReportRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly now?: () => Date;
}

const { model, optional, required, nullable, str, int, bool } = p;

/**
 * The dashboard's report reads and metric writes under /api/v2/bff: list, detail,
 * timeline bundle, metric list and metric insert. Paths, bodies and error texts match the
 * Python BFF.
 */
export function reportRoutes(deps: ReportRoutesDeps) {
  const d: reports.ReportDeps = {
    store: reportsStorage(deps.db),
    access: deps.access,
    now: deps.now ?? (() => new Date()),
  };
  const app = new Hono<Env>();

  app.get("/api/v2/bff/reports", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        project_id: required(str()),
        fields: optional(nullable(str()), null),
        limit: optional(int({ ge: 1, le: 1000 }), 1000),
      },
    });
    return c.json(await reports.listReports(d, who, query.project_id, query.fields, query.limit));
  });

  app.get("/api/v2/bff/reports/:report_id", async (c) => {
    const who = requireUser(c);
    const { path, query } = await p.validate(c.req, {
      path: { report_id: required(str()) },
      query: { include_content: optional(bool(), true) },
    });
    return c.json(await reports.getReport(d, who, path.report_id, query.include_content));
  });

  app.get("/api/v2/bff/reports/:report_id/timeline", async (c) => {
    const who = requireUser(c);
    return c.json(await reports.reportTimeline(d, who, c.req.param("report_id")));
  });

  app.get("/api/v2/bff/report-metrics", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: { report_id: required(str()) } });
    return c.json(await reports.listMetrics(d, who, query.report_id));
  });

  app.post("/api/v2/bff/report-metrics", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        project_report_id: required(str()),
        type: required(str()),
        ip: optional(nullable(str()), null),
      }),
    });
    return c.json(await reports.createMetric(d, who, body.data));
  });

  return app;
}
