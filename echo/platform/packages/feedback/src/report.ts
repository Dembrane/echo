/**
 * The dashboard's issue report: text the support outbox forwards to the team. Server
 * lines come first so free text cannot forge them, and every link is checked before it
 * is forwarded.
 */
export const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_MB = 10;
export const MAX_MESSAGE_LENGTH = 5000;
/** Slack unfurls the preview and caches it; S3 caps presigned GETs at 7 days. */
export const PREVIEW_URL_TTL_SECONDS = 7 * 24 * 3600;
export const ATTACHMENT_URL_TTL_SECONDS = 300;
const MAX_RELATED_ID_LENGTH = 255;
const REPLAY_HOST = "posthog.com";

/** One storage key segment and one URL path segment, so it is allow-listed. */
export function safeFilename(name: string | null | undefined): string {
  let safe = (name ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
  safe = safe.replace(/\.{2,}/g, ".").replace(/^[. ]+/, "");
  return safe || "image";
}

/** API_BASE_URL may or may not end in /api; links are built without it. */
export function attachmentLinkBase(apiBase: string): string {
  let b = apiBase.replace(/\/+$/, "");
  if (b.endsWith("/api")) b = b.slice(0, -4);
  return b;
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value || /[<>|\s]/.test(value)) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.host) return null;
  return value;
}

/** The replay link is shown as a bare label, so it is pinned to PostHog. */
export function safeReplayUrl(value: string | null | undefined): string | null {
  const url = safeHttpUrl(value);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase();
  return host === REPLAY_HOST || host.endsWith(`.${REPLAY_HOST}`) ? url : null;
}

/** support_request relation columns are 255 characters; anything longer is ignored. */
export function safeRelatedId(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v && v.length <= MAX_RELATED_ID_LENGTH ? v : null;
}

export function buildReportMessage(p: {
  reporterName: string;
  reporterEmail: string;
  message: string;
  sessionReplayUrl: string | null;
  attachmentLinks: readonly [string, string][];
}): string {
  const lines = [
    "Issue report from the dashboard",
    "",
    `Reporter: ${p.reporterName} (${p.reporterEmail})`,
  ];
  if (p.attachmentLinks.length) {
    lines.push("Attachments:");
    for (const [preview, durable] of p.attachmentLinks) {
      lines.push(`- ${preview}`);
      lines.push(`  staff link, no expiry: ${durable}`);
    }
    lines.push("Previews expire after 7 days; staff links keep working.");
  }
  const replay = safeReplayUrl(p.sessionReplayUrl);
  if (replay) lines.push(`Session replay: ${replay}`);
  lines.push("", "Message:", p.message);
  return lines.join("\n");
}

export function buildReportPageContext(p: {
  pageUrl: string | null;
  locale: string | null;
  userAgent: string | null;
}): string {
  const parts: string[] = [];
  const page = safeHttpUrl(p.pageUrl);
  if (page) parts.push(`Page: ${page}`);
  if (p.locale) parts.push(`Locale: ${[...p.locale].slice(0, 32).join("")}`);
  if (p.userAgent) parts.push(`Browser: ${[...p.userAgent].slice(0, 150).join("")}`);
  return parts.join(" | ");
}
