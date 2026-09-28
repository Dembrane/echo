import { type Ctx, requireUser } from "@dembrane/http";
import { workspaceContext } from "../context";
import { clock, type TenancyDeps } from "../deps";

/**
 * The order FastAPI resolved things in, which decides which error a bad request gets:
 * session (401), then the workspace dependency (403/404), then body and query (422, via
 * legacy-shape's validate), then the handler's own checks.
 */
export function helpers(deps: TenancyDeps) {
  return {
    user: (c: Ctx) => requireUser(c),
    ws: (c: Ctx, param = "workspace_id") =>
      workspaceContext(deps.accessStore, requireUser(c), c.req.param(param) ?? "", clock(deps)),
  };
}
