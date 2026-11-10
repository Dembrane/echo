import type { Codes } from "./types";

/** The participant portal's AI features (Verify, Explore); never names plans or budgets. */
export const portal = {
  "portal.ai_unavailable": {
    action: "none",
    detail: "Not available right now.",
    description: "Verify or Explore is not available for this project right now.",
  },
} as const satisfies Codes<"portal">;
