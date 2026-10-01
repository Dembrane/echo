import pino, { type Logger } from "pino";
import { correlation } from "./context";

export type { Logger };

export interface LoggerOptions {
  readonly service: string;
  readonly release: string;
  readonly env: string;
  readonly level: string;
  /** GCP project whose Cloud Logging groups a request's log lines by its trace id. */
  readonly gcpProject?: string;
}

// Cloud Logging reads `severity` and `message`, and groups lines that share
// `logging.googleapis.com/trace`. Cloud Trace is off (it has no EU storage), so the id only
// correlates log lines. Anything else in the line lands in jsonPayload and stays queryable.
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
