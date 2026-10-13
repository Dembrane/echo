import type { Codes } from "./types";

/** The staff console: support access, managed billing and workspace fixes by dembrane staff. */
export const staff = {
  "staff.key_cannot_email": {
    action: "none",
    detail:
      "A staff key cannot send this: it would email the customer. A signed-in person sends it from the staff pages.",
    audience: "developer",
    description:
      "A staff API key called a staff route in a way that emails a customer (an offer send, a message, a demo invitation). Only a signed-in staff member's own action sends.",
  },
  "staff.outsider_cannot_be_admin": {
    action: "fix_input",
    detail: "Cannot promote an outside collaborator to admin. Add them to the org first.",
    audience: "staff",
    description: "Staff tried to make an external or observer a workspace admin.",
  },
  "staff.support_access_disabled": {
    action: "contact_admin",
    detail: "This workspace has not enabled dembrane staff support access.",
    audience: "staff",
    description: "Staff tried to join a workspace whose admins have not allowed support access.",
  },
  "staff.support_access_already_on": {
    action: "none",
    detail: "Support access is already on for this workspace; join directly.",
    audience: "staff",
    description: "Staff asked for support access to a workspace that already allows it.",
  },
  "staff.active_subscription": {
    action: "none",
    detail:
      "This account has an active subscription. Ask the customer to cancel it from their billing page first.",
    audience: "staff",
    description: "Staff tried to make an account managed while it has a live Mollie subscription.",
  },
  "staff.already_mollie": {
    action: "none",
    detail: "Account already bills through Mollie.",
    audience: "staff",
    description:
      "Staff tried to switch an account to self-serve that already bills through Mollie.",
  },
  "staff.not_managed": {
    action: "none",
    detail: "Account is not managed.",
    audience: "staff",
    description: "Staff tried to end managed billing on an account that is not managed.",
  },
  "staff.expiry_required": {
    action: "fix_input",
    detail: "An expiry date is required when keeping the tier.",
    audience: "staff",
    description:
      "Switching a managed account to self-serve while keeping its tier needs an expiry date.",
  },
  "staff.billing_refused": {
    action: "none",
    detail: "{reason}",
    audience: "staff",
    description: "The billing service refused a staff change; reason is its message.",
  },
} as const satisfies Codes<"staff">;
