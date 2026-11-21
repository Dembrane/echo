import type { Codes } from "./types";

/** The participant portal's AI features (Verify, Explore); never names plans or budgets. */
export const portal = {
  "portal.ai_unavailable": {
    action: "none",
    detail: "Not available right now.",
    description: "Verify or Explore is not available for this project right now.",
  },
  "portal.try_failed": {
    action: "retry",
    detail: "The try did not work.",
    description:
      "The portal editor's Try it ran the host's settings on the sample conversation and the model call failed or refused.",
  },
} as const satisfies Codes<"portal">;
