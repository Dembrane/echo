import { newId } from "@echo/core";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  withCorrelation,
} from "@echo/observability";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { Deps, Env } from "../deps";

/**
 * Opens the request span, continues an incoming W3C trace, and binds the request id so
 * every log line and downstream call carries it. Echoes the id back as X-Request-Id so a
 * user-reported error can be found in one search.
 */
export function correlation(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? newId();
    const carrier = Object.fromEntries(c.req.raw.headers);
    const parent = propagation.extract(context.active(), carrier);
    const span = deps.tracer.startSpan(
      `${c.req.method} ${c.req.path}`,
      { kind: SpanKind.SERVER },
      parent,
    );
    const sc = span.spanContext();
    const logger = deps.logger.child({});
    c.set("requestId", requestId);
    c.set("logger", logger);
    c.header("x-request-id", requestId);
    const started = performance.now();
    try {
      await withCorrelation({ requestId, traceId: sc.traceId, spanId: sc.spanId }, () =>
        context.with(trace.setSpan(parent, span), next),
      );
    } finally {
      const route = routePath(c);
      const status = c.res.status;
      span.updateName(`${c.req.method} ${route}`);
      span.setAttributes({
        "http.request.method": c.req.method,
        "http.route": route,
        "http.response.status_code": status,
      });
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      withCorrelation({ requestId, traceId: sc.traceId, spanId: sc.spanId }, () =>
        logger[status >= 500 ? "error" : "info"](
          {
            httpRequest: {
              requestMethod: c.req.method,
              requestUrl: c.req.path,
              status,
              latency: `${((performance.now() - started) / 1000).toFixed(3)}s`,
            },
            route,
          },
          "request",
        ),
      );
    }
  };
}
