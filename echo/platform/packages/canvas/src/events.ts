import type { Logger } from "@dembrane/observability";
import { publish, sharedHub } from "@dembrane/realtime";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type postgres from "postgres";

/**
 * Canvas generation nudges. A nudge says only that a report has a new generation; the
 * stream reads which one when it forwards the nudge, so a page always shows the newest.
 */
export function generationChannel(reportId: string): string {
  return `canvas:generation:${reportId}`;
}

/** Best effort: a lost nudge is recovered by the page's own reread on (re)connect. */
export async function publishGenerationNudge(
  sql: postgres.Sql,
  reportId: string,
  logger?: Logger,
): Promise<void> {
  if (!reportId) return;
  await publish(sql, generationChannel(reportId), { type: "generation" }, logger);
}

export const HEARTBEAT_MS = 15_000;

/** Python's json.dumps with default separators, which the frontend has always parsed. */
function pyJson(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(
    ([k, v]) =>
      `${JSON.stringify(k)}: ${v === null || v === undefined ? "null" : JSON.stringify(v)}`,
  );
  return `{${parts.join(", ")}}`;
}

/**
 * The stream the canvas page follows: `connected`, then one `generation` frame per nudge
 * with the latest generation id read at that moment, and a comment every 15 seconds.
 */
export function canvasEventStream(
  c: Context,
  args: {
    sql: postgres.Sql;
    logger: Logger;
    reportId: string;
    latestGenerationId: () => Promise<unknown>;
    heartbeatMs?: number;
  },
) {
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");
  c.header("Content-Type", "text/event-stream; charset=utf-8");
  return stream(c, async (s) => {
    const hub = await sharedHub(args.sql, args.logger);
    let pending = 0;
    let wake: (() => void) | null = null;
    const unsubscribe = hub.subscribe([generationChannel(args.reportId)], () => {
      pending++;
      wake?.();
    });
    let closed = false;
    s.onAbort(() => {
      closed = true;
      wake?.();
    });
    const beat = args.heartbeatMs ?? HEARTBEAT_MS;
    try {
      await s.write(`event: connected\ndata: ${pyJson({ type: "connected" })}\n\n`);
      let last = Date.now();
      while (!closed) {
        if (pending > 0) {
          pending--;
          const id = await args.latestGenerationId();
          await s.write(
            `event: generation\ndata: ${pyJson({ type: "generation", generation_id: id ?? null })}\n\n`,
          );
          continue;
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, Math.max(0, beat - (Date.now() - last)));
        });
        wake = null;
        if (closed || pending > 0) continue;
        if (Date.now() - last >= beat) {
          await s.write(": keep-alive\n\n");
          last = Date.now();
        }
      }
    } finally {
      unsubscribe();
    }
  });
}
