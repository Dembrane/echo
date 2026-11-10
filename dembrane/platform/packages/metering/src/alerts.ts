import { createHash } from "node:crypto";
import type { Logger } from "@dembrane/observability";

export type FetchText = (url: string) => Promise<string>;

/** GET a URL as text; throws on a network failure or a non-2xx answer. */
export const httpText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
};

/** sam's inbox code for one AI cost alert line. */
export const AI_COST_ALERT_CODE = "dembrane_ai_cost_alert_v1";
/** sam refuses a longer text; a longer alert is cut to it. */
export const AI_COST_ALERT_MAX_CHARS = 3000;

/** One alert as a sam inbox message: the code, `{ text, day }`, and its dedupe id. */
export type CostAlertMessage = {
  readonly code: string;
  /** The day too, since sam drops a payload it saw in the last 30 days whatever the id. */
  readonly json: { readonly text: string; readonly day: string };
  readonly id: string;
};

/** Queues one alert for sam's inbox; the app wires it, null keeps alerts in the log. */
export type CostAlertSink = (message: CostAlertMessage) => Promise<void>;

/** The id is the UTC day and a hash of the text: a rerun the same day repeats it, another alert never does. */
export function costAlertMessage(text: string, at: Date): CostAlertMessage {
  const chars = [...text];
  const bounded =
    chars.length > AI_COST_ALERT_MAX_CHARS
      ? `${chars.slice(0, AI_COST_ALERT_MAX_CHARS - 1).join("")}…`
      : text;
  const day = at.toISOString().slice(0, 10);
  const hash = createHash("sha256").update(bounded, "utf8").digest("hex").slice(0, 16);
  return { code: AI_COST_ALERT_CODE, json: { text: bounded, day }, id: `${day}-${hash}` };
}

/** Logs one alert and hands it to the sink; never throws. */
export async function postCostAlert(
  sink: CostAlertSink | null,
  text: string,
  logger: Logger,
  at: Date = new Date(),
): Promise<void> {
  const message = costAlertMessage(text, at);
  logger.info({ signal: "metering.cost_alert", alert_id: message.id, text }, "AI cost alert");
  if (!sink) return;
  try {
    await sink(message);
  } catch (err) {
    logger.warn({ err, alert_id: message.id }, "AI cost alert not queued for sam's inbox");
  }
}
