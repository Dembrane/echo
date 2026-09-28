import type { Codes } from "./types";

/** Who the caller is: sessions, tokens and sign-in. */
export const auth = {
  "auth.session_expired": {
    action: "sign_in",
    detail: "Invalid session",
    description: "The request carried no valid session: never signed in, signed out, or expired.",
  },
  "auth.token_invalid": {
    action: "sign_in",
    detail: "Invalid or expired token",
    audience: "developer",
    description: "A bearer token is missing, malformed, revoked or expired.",
  },
  "auth.user_required": {
    action: "sign_in",
    detail: "Authenticated user required.",
    description: "A per-user rate limit ran without a signed-in user id; answers 403.",
  },
  "auth.token_required": {
    action: "sign_in",
    detail: "Bearer token required",
    audience: "developer",
    description: "An agent route was called without an Authorization bearer token.",
  },
} as const satisfies Codes<"auth">;
