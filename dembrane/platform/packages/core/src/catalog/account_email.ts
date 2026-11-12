import type { Codes } from "./types";

/** The account card's email, read live from dembrane's mailboxes. */
export const account_email = {
  "account_email.not_configured": {
    action: "contact_support",
    detail: "Email is not connected here",
    audience: "staff",
    description:
      "This environment has no Gmail service account or no mailboxes (ACCOUNTS_GMAIL_SERVICE_ACCOUNT, ACCOUNTS_GMAIL_MAILBOXES).",
  },
} as const satisfies Codes<"account_email">;
