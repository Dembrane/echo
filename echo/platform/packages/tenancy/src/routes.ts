import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { TenancyDeps } from "./deps";
import { accessRoutes } from "./routes/access";
import { orgRoutes } from "./routes/orgs";
import { settingsRoutes } from "./routes/settings";
import { workspaceRoutes } from "./routes/workspaces";

/** Orgs, workspaces, their settings and members, access requests, support access and project shares. */
export function tenancyRoutes(deps: TenancyDeps) {
  return new Hono<Env>()
    .route("/", workspaceRoutes(deps))
    .route("/", settingsRoutes(deps))
    .route("/", accessRoutes(deps))
    .route("/", orgRoutes(deps));
}
