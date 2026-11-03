import type { Codes } from "./types";

/** The participant portal's AI features (Verify, Explore); never names plans or budgets. */
export const portal = {
  "portal.ai_unavailable": {
    action: "none",
    detail: "Not available right now.",
    description:
      "Verify or Explore was refused because the project's free AI budget is used up; participants are not told why.",
  },
} as const satisfies Codes<"portal">;
