import type { Codes } from "./types";

export const rate_limit = {
  "rate_limit.exceeded": {
    action: "wait",
    detail: "Too many requests. Try again later.",
    params: ["retry_after_seconds"],
    description: "The caller sent too many requests in the window; retry after the wait.",
  },
  "rate_limit.too_many_streams": {
    action: "wait",
    detail: "Too many open streams. Try again later.",
    description:
      "The caller holds as many live update streams as allowed (globally or per key); close a tab or wait.",
  },
} as const satisfies Codes<"rate_limit">;
