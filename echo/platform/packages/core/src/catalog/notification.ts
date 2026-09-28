import type { Codes } from "./types";

export const notification = {
  "notification.not_found": {
    action: "none",
    detail: "Notification not found",
    description: "The notification does not exist or belongs to someone else.",
  },
} as const satisfies Codes<"notification">;
