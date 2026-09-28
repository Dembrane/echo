import type { Db } from "@dembrane/db";
import type postgres from "postgres";

/**
 * Report generation publishes progress on this Postgres channel as
 * `{"report_id": <id>, "event": {"type": ..., "message": ...}}`; the stream below forwards
 * the event of one report. Postgres is the only stateful dependency, so this replaces the
 * Redis pub/sub channel the Python worker used.
 */
export const REPORT_PROGRESS_CHANNEL = "report_progress";

const HEARTBEAT_MS = 10_000;

/** Python's json.dumps spacing, which the dashboard's event parser has always seen. */
function frame(type: string, message: string): string {
  return `event: progress\ndata: {"type": "${type}", "message": "${message}"}\n\n`;
}

export function progressStream(
  db: Db,
  reportId: number,
  start: "completed" | "failed" | "running",
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // A notification can land after the stream was cancelled; drop it.
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {}
      };
      if (start === "completed") {
        send(frame("completed", "Report ready"));
        controller.close();
        return;
      }
      if (start === "failed") {
        send(frame("failed", "Report generation failed"));
        controller.close();
        return;
      }
      const client = (db as unknown as { $client: postgres.Sql }).$client;
      let done = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let listener: { unlisten(): Promise<void> } | undefined;
      const finish = async () => {
        if (done) return;
        done = true;
        clearInterval(heartbeat);
        await listener?.unlisten().catch(() => {});
        try {
          controller.close();
        } catch {}
      };
      try {
        listener = await client.listen(REPORT_PROGRESS_CHANNEL, (raw) => {
          let msg: { report_id?: unknown; event?: { type?: unknown } };
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }
          if (Number(msg.report_id) !== reportId || !msg.event) return;
          send(`event: progress\ndata: ${JSON.stringify(msg.event)}\n\n`);
          if (msg.event.type === "completed" || msg.event.type === "failed") void finish();
        });
        send(frame("connected", "Connected"));
        heartbeat = setInterval(() => send("event: heartbeat\ndata: {}\n\n"), HEARTBEAT_MS);
        if (signal.aborted) void finish();
        else signal.addEventListener("abort", () => void finish());
      } catch {
        send(frame("failed", "Stream error"));
        await finish();
      }
    },
  });
}
