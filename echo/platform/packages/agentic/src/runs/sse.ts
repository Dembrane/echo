import type { Logger } from "@dembrane/observability";
import { pyJson } from "../agent/events";
import { DraftAssembler, runChannel, sharedHub, watchRun } from "./live";
import { type Row, type RunsStorage, TERMINAL_RUN_STATUSES } from "./storage";

/** One stored event as the dashboard's stream parser reads it. */
export function eventFrame(event: Row, seq: number): string {
  return `id: ${seq}\nevent: ${String(event.event_type)}\ndata: ${pyJson(event)}\n\n`;
}

export function draftFrame(messageId: string, text: string): string {
  return `event: assistant.draft\ndata: ${pyJson({
    event_type: "assistant.draft",
    payload: { message_id: messageId, text },
  })}\n\n`;
}

export const HEARTBEAT_FRAME = "event: heartbeat\ndata: {}\n\n";

export interface StreamDeps {
  readonly store: RunsStorage;
  readonly logger: Logger;
  readonly heartbeatMs: number;
  /** How long to wait for a live event before re-reading the table; the Python loop's 1s. */
  readonly idleMs?: number;
}

type Live =
  | { kind: "event"; event: Row }
  | { kind: "nudge"; seq: number }
  | { kind: "draft"; message_id: string; part: number; of: number; text: string };

/**
 * The run's events from `afterSeq`: what is stored, then live events as the turn writes
 * them, and drafts, which are never stored. The table stays the source of truth: every idle
 * second it is read again, so a missed notification only delays an event. The stream ends
 * after the final drain once the run is terminal. While it is open the run counts as
 * watched, so the turn does not also send an inbox notification.
 */
export function liveEventStream(
  d: StreamDeps,
  runId: string,
  afterSeq: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = afterSeq;
      let closed = false;
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      const queue: Live[] = [];
      let wake: (() => void) | null = null;
      let unsubscribe: (() => void) | null = null;
      let unwatch: (() => Promise<void>) | null = null;
      const onAbort = () => {
        closed = true;
        wake?.();
      };
      signal.addEventListener("abort", onAbort);
      const delta = async () => {
        for (const e of await d.store.listEvents(runId, cursor)) {
          const seq = Number(e.seq ?? cursor);
          if (seq <= cursor) continue;
          cursor = seq;
          send(eventFrame(e, seq));
        }
      };
      try {
        const hub = await sharedHub(d.store.sql, d.logger);
        unsubscribe = hub.subscribe([runChannel(runId)], (e) => {
          queue.push(e as unknown as Live);
          wake?.();
        });
        unwatch = await watchRun(d.store.sql, runId, d.logger);
        const drafts = new DraftAssembler();
        await delta();
        await delta();
        let lastBeat = Date.now();
        while (!closed) {
          if (!queue.length)
            await new Promise<void>((r) => {
              wake = r;
              setTimeout(r, d.idleMs ?? 1000);
            });
          wake = null;
          if (closed) break;
          const live = queue.shift();
          if (live) {
            if (live.kind === "draft") {
              const text = drafts.add(live);
              if (text !== null) send(draftFrame(live.message_id, text));
            } else if (live.kind === "event") {
              const seq = Number(live.event.seq ?? 0);
              // Events stored while this stream read the table arrive again live.
              if (seq > cursor + 1) await delta();
              if (seq > cursor) {
                cursor = seq;
                send(eventFrame(live.event, seq));
              }
            } else if (live.kind === "nudge") {
              if (Number(live.seq) > cursor) await delta();
            }
            continue;
          }
          await delta();
          const run = await d.store.get(runId);
          if (!run || TERMINAL_RUN_STATUSES.has(String(run.status ?? ""))) {
            await delta();
            break;
          }
          if (Date.now() - lastBeat >= d.heartbeatMs) {
            send(HEARTBEAT_FRAME);
            lastBeat = Date.now();
          }
        }
      } catch (err) {
        d.logger.warn({ err, runId }, "live run stream failed; falling back to polling");
        if (!closed) {
          const reader = pollingEventStream(d, runId, cursor, signal).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done || closed) break;
            controller.enqueue(value);
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        await unwatch?.();
        closed = true;
        try {
          controller.close();
        } catch {}
      }
    },
  });
}

/**
 * The events endpoint's stream (Accept: text/event-stream): stored events only, read
 * again each heartbeat interval, ending once the run is terminal and drained.
 */
export function pollingEventStream(
  d: StreamDeps,
  runId: string,
  afterSeq: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = afterSeq;
      try {
        while (!signal.aborted) {
          const events = await d.store.listEvents(runId, cursor);
          if (events.length) {
            for (const e of events) {
              const seq = Number(e.seq ?? cursor);
              if (seq <= cursor) continue;
              cursor = seq;
              controller.enqueue(enc.encode(eventFrame(e, seq)));
            }
            continue;
          }
          const run = await d.store.get(runId);
          if (!run || TERMINAL_RUN_STATUSES.has(String(run.status ?? ""))) break;
          await new Promise<void>((r) => {
            const t = setTimeout(r, d.heartbeatMs);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                r();
              },
              { once: true },
            );
          });
          if (signal.aborted) break;
          controller.enqueue(enc.encode(HEARTBEAT_FRAME));
        }
      } catch (err) {
        d.logger.warn({ err, runId }, "run event stream failed");
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
}
