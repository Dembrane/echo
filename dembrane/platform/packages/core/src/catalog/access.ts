import type { Codes } from "./types";

/** The caller is known but may not do this. */
export const access = {
  "access.forbidden": {
    action: "contact_admin",
    detail: "Not allowed",
    params: ["admin_name", "admin_email"],
    description:
      "The caller lacks the role or membership for this action. admin_name and admin_email name who can grant it, when known.",
  },
  "access.not_onboarded": {
    action: "none",
    detail: "User not onboarded",
    description: "The signed-in user has not finished onboarding (no organisation yet).",
  },
  "access.staff_only": {
    action: "none",
    detail: "Staff-only",
    audience: "staff",
    description: "The action is reserved for dembrane staff.",
  },
  "access.support_session_limited": {
    action: "none",
    detail: "A staff support session cannot do this",
    audience: "staff",
    description:
      "A staff member on a temporary support grant tried an action the grant leaves to the customer.",
  },
} as const satisfies Codes<"access">;
