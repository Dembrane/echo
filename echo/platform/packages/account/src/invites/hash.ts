import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The opaque pointer in invite emails: HMAC-SHA256(invite id) under the invite secret,
 * first 32 hex characters. Unforgeable without the secret and safe to log. The secret is
 * Directus's SECRET until cutover, so links already in inboxes keep working.
 */
export function inviteHash(secret: string, inviteId: string): string {
  return createHmac("sha256", secret).update(inviteId).digest("hex").slice(0, 32);
}

/** Constant-time comparison of a presented hash with an invite's hash. */
export function hashMatches(secret: string, inviteId: string, presented: string): boolean {
  const want = Buffer.from(inviteHash(secret, inviteId));
  const got = Buffer.from(presented);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Python's urlencode (quote_plus): only letters, digits and _.-~ stay; spaces become "+". */
export function urlencode(params: Record<string, string>): string {
  const q = (v: string) =>
    encodeURIComponent(v)
      .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%20/g, "+");
  return Object.entries(params)
    .map(([k, v]) => `${q(k)}=${q(v)}`)
    .join("&");
}

/** /invite/accept?iss=..&role=..&email=..&h=..&(ws|org)=.. in the order the old API built it. */
export function inviteAcceptUrl(opts: {
  type: "workspace" | "org";
  dashboardUrl: string;
  hash: string;
  inviterName: string;
  subjectName: string;
  role: string;
  email: string;
}): string {
  const params: Record<string, string> = {
    iss: opts.inviterName,
    role: opts.role,
    email: opts.email,
    h: opts.hash,
  };
  params[opts.type === "workspace" ? "ws" : "org"] = opts.subjectName;
  return `${opts.dashboardUrl}/invite/accept?${urlencode(params)}`;
}

/** The resend path builds its query in a different order: iss, ws|org, role, email, h. */
export function resendAcceptUrl(opts: {
  type: "workspace" | "org";
  dashboardUrl: string;
  hash: string;
  inviterName: string;
  subjectName: string;
  role: string;
  email: string;
}): string {
  return `${opts.dashboardUrl}/invite/accept?${urlencode({
    iss: opts.inviterName,
    [opts.type === "workspace" ? "ws" : "org"]: opts.subjectName,
    role: opts.role,
    email: opts.email,
    h: opts.hash,
  })}`;
}
