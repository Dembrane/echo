import type { Access } from "@echo/access";
import type { Db } from "@echo/db";
import { type Env, requireUser } from "@echo/http";
import { Hono } from "hono";
import * as reports from "./service";
import { reportsStorage } from "./storage";

export interface ReportRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly now?: () => Date;
}

/**
 * The report timeline bundle the dashboard reads under /api/v2/bff. Paths, bodies and
 * error texts match the Python BFF.
 */
export function reportRoutes(deps: ReportRoutesDeps) {
  const d: reports.ReportDeps = {
    store: reportsStorage(deps.db),
    access: deps.access,
    now: deps.now ?? (() => new Date()),
  };
  const app = new Hono<Env>();

  app.get("/api/v2/bff/reports/:report_id/timeline", async (c) => {
    const who = requireUser(c);
    return c.json(await reports.reportTimeline(d, who, c.req.param("report_id")));
  });

  return app;
}
