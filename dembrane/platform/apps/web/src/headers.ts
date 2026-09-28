/** Third parties the frontend loads today (analytics, forms, booking, video, fonts). */
const THIRD_PARTY = {
  script: [
    "https://r.dembrane.com",
    "https://eu-assets.i.posthog.com",
    "https://tally.so",
    "https://app.cal.com",
    "https://cal.com",
  ],
  connect: [
    "https://eu.i.posthog.com",
    "https://eu-assets.i.posthog.com",
    "https://*.tally.so",
    "https://tally.so",
    "https://app.cal.com",
    "https://cal.com",
  ],
  frame: [
    "https://*.tally.so",
    "https://www.youtube-nocookie.com",
    "https://app.cal.com",
    "https://cal.com",
  ],
  font: ["https://fonts.gstatic.com", "https://cal.com"],
};

export interface HeaderInputs {
  /** Origins of our own apps and storage this deployment talks to. */
  readonly own: readonly string[];
  readonly storage: readonly string[];
}

/**
 * The security headers that lived in vercel.json. The CSP is built from configuration
 * instead of listing every environment's hosts, so a new environment needs no edit here.
 */
export function securityHeaders(inp: HeaderInputs): Record<string, string> {
  const own = [...new Set(inp.own)];
  const wss = own
    .filter((o) => o.startsWith("https://"))
    .map((o) => o.replace("https://", "wss://"));
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${THIRD_PARTY.script.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `font-src 'self' data: ${THIRD_PARTY.font.join(" ")}`,
    `img-src 'self' data: blob: ${[...own, ...inp.storage].join(" ")}`,
    `connect-src 'self' ${[...own, ...wss, ...inp.storage, ...THIRD_PARTY.connect].join(" ")}`,
    `media-src 'self' blob: mediastream: ${inp.storage.join(" ")}`,
    `frame-src 'self' ${[...own, ...THIRD_PARTY.frame].join(" ")}`,
    `frame-ancestors 'self' ${own.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self' https://*.tally.so",
    "base-uri 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), interest-cohort=()",
  };
}
