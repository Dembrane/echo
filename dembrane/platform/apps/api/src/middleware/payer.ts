import { type Payer, type PayerRefKind, withPayer } from "@dembrane/observability";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";

// First matching rule wins; a param's id kind can depend on the route. Ids resolve when the recorder flushes.
type Rule = readonly [param: string, kind: PayerRefKind, applies?: (path: string) => boolean];
const under = (prefix: string) => (path: string) => path.startsWith(prefix);

const PAYER_PARAMS: readonly Rule[] = [
  ["project_id", "project"],
  ["conversation_id", "conversation"],
  ["chat_id", "chat"],
  ["run_id", "analysis_run", under("/api/v2/bff/analysis/")],
  ["run_id", "agent_run", under("/api/agentic/runs/")],
  // A feedback report is not a project report.
  ["report_id", "report", (path) => !path.startsWith("/api/v2/feedback/")],
  // Canvas routes take the canvas's project_report id; the "canvas" kind is the canvas jobs' agent_loop.
  ["canvas_id", "report"],
  ["artifact_id", "verify_artifact"],
  ["loop_id", "popcorn_loop"],
  ["workspace_id", "workspace"],
];

/** The handler's route params; a middleware's own c.req.param() sees only its `*` pattern. */
function handlerParams(c: Context): Record<string, string> {
  const index = matchedRoutes(c).findLastIndex((r) => !r.path.endsWith("*"));
  if (index < 0) return {};
  const own = c.req.routeIndex;
  c.req.routeIndex = index;
  try {
    return c.req.param() as Record<string, string>;
  } finally {
    c.req.routeIndex = own;
  }
}

function payerOf(c: Context): Payer | null {
  const params = handlerParams(c);
  for (const [key, ref, applies] of PAYER_PARAMS) {
    const id = params[key];
    if (id && (!applies || applies(c.req.path))) return { ref, id };
  }
  return null;
}

/** Runs the request in the payer scope its route names: metering only, never access control. */
export function payerMiddleware(): MiddlewareHandler {
  return (c, next) => {
    const p = payerOf(c);
    return p ? withPayer(p, next) : next();
  };
}
