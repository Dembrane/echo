import pino, { type Logger } from "pino";
import { correlation } from "./context";

export type { Logger };

export interface LoggerOptions {
  readonly service: string;
  readonly release: string;
  readonly env: string;
  readonly level: string;
  /** GCP project that owns the traces, so Cloud Logging links a log line to its trace. */
  readonly gcpProject?: string;
}

// Cloud Logging reads `severity` and `message`, and links `logging.googleapis.com/trace`
// to Cloud Trace. Anything else in the line lands in jsonPayload and stays queryable.
const SEVERITY: Record<string, string> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

const REDACT = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
];

export function createLogger(opts: LoggerOptions, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level: opts.level,
      messageKey: "message",
      base: { service: opts.service, release: opts.release, env: opts.env },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT, censor: "[redacted]" },
      formatters: {
        level: (label) => ({ severity: SEVERITY[label] ?? "DEFAULT", level: label }),
      },
      mixin() {
        const c = correlation();
        if (!c) return {};
        return {
          request_id: c.requestId,
          ...(c.causedByRequestId && { caused_by_request_id: c.causedByRequestId }),
          ...(c.traceId &&
            opts.gcpProject && {
              "logging.googleapis.com/trace": `projects/${opts.gcpProject}/traces/${c.traceId}`,
              "logging.googleapis.com/spanId": c.spanId,
            }),
          ...(c.traceId && !opts.gcpProject && { trace_id: c.traceId }),
        };
      },
    },
    destination,
  );
}
