import { createHmac } from "node:crypto";

/**
 * The opaque pointer in invite emails: HMAC-SHA256 of the invite id, first 32 hex chars.
 * The secret must equal the old API's DIRECTUS_SECRET until every link sent before the
 * cutover has expired, or those links stop resolving.
 */
export function inviteHash(inviteId: string, secret: string): string {
  return createHmac("sha256", secret).update(inviteId).digest("hex").slice(0, 32);
}

/** Python's urllib quote_plus: space as '+', only letters, digits and `_.-~` left bare. */
function quotePlus(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** /invite/accept?iss=...&role=...&email=...&h=...&(ws|org)=..., parameters in the old order. */
export function inviteAcceptUrl(opts: {
  type: "workspace" | "org";
  dashboardUrl: string;
  hash: string;
  inviterName: string;
  subjectName: string;
  role: string;
  email: string;
}): string {
  const params: [string, string][] = [
    ["iss", opts.inviterName],
    ["role", opts.role],
    ["email", opts.email],
    ["h", opts.hash],
    [opts.type === "workspace" ? "ws" : "org", opts.subjectName],
  ];
  const query = params.map(([k, v]) => `${k}=${quotePlus(v)}`).join("&");
  return `${opts.dashboardUrl}/invite/accept?${query}`;
}

/** Dashboard URLs the emails and notifications point at. */
export function dashboardPath(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  return b ? `${b}${path}` : path;
}
