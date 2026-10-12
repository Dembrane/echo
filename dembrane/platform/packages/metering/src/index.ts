import { type Db, schema } from "@dembrane/db";
import type { ModelCall, ModelCallObserver } from "@dembrane/llm";
import { correlation, type Logger } from "@dembrane/observability";

/** A model_call row as stored: the call plus who made it and under which operation. */
export type ModelCallRow = typeof schema.model_call.$inferInsert;

export interface ModelCallSink {
  insert(rows: readonly ModelCallRow[]): Promise<void>;
}

export interface RecorderOptions {
  readonly sink: ModelCallSink;
  readonly logger: Logger;
  /** The process making the calls: echo-api or echo-worker. */
  readonly service: string;
  /** How long rows wait for company before one insert writes them all. */
  readonly flushMs?: number;
  /** Rows kept while the database is unreachable; older ones are dropped beyond this. */
  readonly maxPending?: number;
}

export interface ModelCallRecorder {
  readonly observe: ModelCallObserver;
  /** Writes what is pending now; the app calls it once before it exits. */
  flush(): Promise<void>;
}

const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_MAX_PENDING = 2000;

/**
 * Hears every model call, logs one line for it at once (Loki and Cloud Logging read
 * that), and writes it to model_call in small batches so a burst of transcriptions costs
 * one insert, not one per chunk. A failing database never fails a model call: the batch
 * is kept for the next flush and dropped only past the cap, with one warning per outage.
 */
export function modelCallRecorder(opts: RecorderOptions): ModelCallRecorder {
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  const maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
  let pending: ModelCallRow[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let failing = false;

  const flush = async (): Promise<void> => {
    if (inFlight) return inFlight;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    inFlight = opts.sink
      .insert(batch)
      .then(() => {
        if (failing) opts.logger.info({ rows: batch.length }, "model call rows write again");
        failing = false;
      })
      .catch((err) => {
        // Oldest first out, so what is kept is the most recent picture.
        pending = [...batch, ...pending].slice(-maxPending);
        if (!failing)
          opts.logger.warn(
            { err, pending: pending.length, max: maxPending },
            "model call rows could not be written; kept for the next flush",
          );
        failing = true;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const observe: ModelCallObserver = (call: ModelCall) => {
    const c = correlation();
    const operation = c?.operation ?? null;
    opts.logger.info(
      {
        signal: "model.call",
        group: call.group,
        model: call.model,
        kind: call.kind,
        operation,
        status: call.status,
        error: call.error,
        finish_reason: call.finishReason,
        attempt: call.attempt,
        fallback: call.fallback,
        ms: call.ms,
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
      },
      "model call",
    );
    pending.push(toRow(call, opts.service, operation, c?.requestId ?? null));
    if (pending.length > maxPending) pending = pending.slice(-maxPending);
    if (!timer) {
      timer = setTimeout(() => void flush(), flushMs);
      // A pending batch never keeps a finished process alive; the app flushes on exit.
      (timer as { unref?: () => void }).unref?.();
    }
  };

  return { observe, flush };
}

export function toRow(
  call: ModelCall,
  service: string,
  operation: string | null,
  requestId: string | null,
): ModelCallRow {
  return {
    started_at: call.startedAt,
    service,
    operation,
    request_id: requestId,
    model_group: call.group,
    model: call.model,
    kind: call.kind,
    status: call.status,
    error: call.error,
    finish_reason: call.finishReason,
    attempt: call.attempt,
    fallback: call.fallback,
    ms: call.ms,
    input_tokens: call.inputTokens,
    output_tokens: call.outputTokens,
  };
}

/** The production sink: one insert per batch into model_call. */
export function modelCallTable(db: Db): ModelCallSink {
  return {
    async insert(rows) {
      if (rows.length) await db.insert(schema.model_call).values([...rows]);
    },
  };
}
