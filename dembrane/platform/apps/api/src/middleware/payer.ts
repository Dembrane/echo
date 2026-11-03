import { type Payer, type PayerRefKind, withPayer } from "@dembrane/observability";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";

// First param found wins. Ids resolve to accounts when the recorder flushes, not here.
const PAYER_PARAMS: readonly (readonly [string, PayerRefKind])[] = [
  ["project_id", "project"],
  ["conversation_id", "conversation"],
  ["chat_id", "chat"],
  ["run_id", "agent_run"],
  ["report_id", "report"],
  ["canvas_id", "canvas"],
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
  for (const [key, ref] of PAYER_PARAMS) {
    const id = params[key];
    if (id) return { ref, id };
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
