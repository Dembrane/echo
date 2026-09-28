import type { Codes } from "./types";

/** Failures on our side. The details stay in the logs; the person gets a retry. */
export const internal = {
  "internal.unexpected": {
    action: "retry",
    detail: "Internal Server Error",
    description:
      "An error nobody threw on purpose; the log line with the request id has the stack.",
  },
  "internal.unavailable": {
    action: "retry",
    detail: "Service Unavailable",
    description: "A dependency (database, store, model) did not answer; nothing was written.",
  },
  "internal.busy": {
    action: "retry",
    detail: "Busy, try again in a second",
    description: "A lock was held or its store away; the response carries Retry-After.",
  },
} as const satisfies Codes<"internal">;
