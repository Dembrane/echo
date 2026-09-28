import type { Logger } from "@dembrane/observability";

/** Product analytics (PostHog). Fire and forget: a failed capture never fails the caller. */
export type Capture = (
  distinctId: string,
  event: string,
  properties: Record<string, unknown>,
) => Promise<void>;

export const noCapture: Capture = async () => {};

const HOST = "https://eu.i.posthog.com";
// Ingest keys are public by design (the frontend bundle ships them). Only production and
// echo-next capture; every other host opts out so stray environments never pollute them.
const TOKENS: Record<string, string> = {
  "dashboard.dembrane.com": "phc_o9ZqNqaop7cwLvbbEU2gwvaY5CczpavbNfCxrnu2Ca4a",
  "dashboard.echo-next.dembrane.com": "phc_qMo8i67hwneqDG3x8NW4iTyUiqPMsR9pZ3H5QaJQ4zkM",
};

/** Server-side capture into the project the dashboard host belongs to, as the Python API did. */
export function posthogCapture(dashboardUrl: string, logger: Logger, fetchFn = fetch): Capture {
  let host = "";
  try {
    host = new URL(dashboardUrl).hostname.toLowerCase();
  } catch {}
  const token = TOKENS[host];
  if (!token) return noCapture;
  return async (distinctId, event, properties) => {
    try {
      const res = await fetchFn(`${HOST}/capture/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: token,
          event,
          distinct_id: distinctId,
          properties: { ...properties, $lib: "dembrane-server" },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status >= 400) logger.warn({ event, status: res.status }, "posthog capture refused");
    } catch (err) {
      logger.warn({ err, event }, "posthog capture failed");
    }
  };
}
