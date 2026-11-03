import type { Logger } from "@dembrane/observability";

export type FetchText = (url: string) => Promise<string>;

/** GET a URL as text; throws on a network failure or a non-2xx answer. */
export const httpText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
};

/** Posts one line to a Slack incoming webhook; unset is off, and a failure is only logged. */
export async function postSlack(url: string | null, text: string, logger: Logger): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn({ status: res.status }, "AI cost Slack webhook refused a message");
  } catch (err) {
    logger.warn({ err }, "AI cost Slack webhook unreachable");
  }
}
