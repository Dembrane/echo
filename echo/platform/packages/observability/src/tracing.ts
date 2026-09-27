import {
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface TracingOptions {
  readonly service: string;
  readonly release: string;
  readonly env: string;
  /** Unset keeps spans in-process only: correlation ids still flow, nothing is exported. */
  readonly otlpEndpoint?: string | undefined;
  readonly sampleRatio: number;
}

export interface Tracing {
  readonly tracer: Tracer;
  shutdown(): Promise<void>;
}

/**
 * Manual instrumentation on purpose: Bun does not run Node's require hooks, so the
 * auto-instrumentations do nothing there. HTTP, database and outbound calls get spans
 * from our own middleware and wrappers instead.
 */
export function initTracing(opts: TracingOptions): Tracing {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.service,
      [ATTR_SERVICE_VERSION]: opts.release,
      "deployment.environment.name": opts.env,
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(opts.sampleRatio) }),
    spanProcessors: opts.otlpEndpoint
      ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` }))]
      : [],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return {
    tracer: trace.getTracer(opts.service, opts.release),
    shutdown: () => provider.shutdown(),
  };
}

/** Runs fn inside a span, recording failure and always ending the span. */
export async function inSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

export type { Tracer };
export { context, propagation, SpanKind, SpanStatusCode, trace };
