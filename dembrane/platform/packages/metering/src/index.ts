import { AI_SPEND_KEY, periodStart } from "@dembrane/allowance";
import { type Db, schema } from "@dembrane/db";
import type { ModelCall, ModelCallObserver } from "@dembrane/llm";
import { correlation, type Logger, type Payer, payer, payerKey } from "@dembrane/observability";
import { sql } from "drizzle-orm";
import { priceCall } from "./prices/pricer";
import type { PriceBook } from "./prices/store";
import { type Resolution, resolvePayers } from "./resolve";
import { postSlack } from "./slack";

export { configuredModels, type MeteringJobDeps, meteringRegistration, priceSync } from "./jobs";
export {
  loadOverrides,
  type OverrideFile,
  type PriceRow,
  type PriceSnapshot,
  type UnitPrices,
} from "./prices/book";
export { pricesFromModelsDev } from "./prices/models-dev";
export { type CallCost, priceCall } from "./prices/pricer";
export { FALLBACK_USD_TO_EUR, type PriceBook, priceBook } from "./prices/store";
export {
  ecbUsdRate,
  missingPriceText,
  type PriceStartup,
  priceStartup,
  type SyncDeps,
  type SyncResult,
  syncPrices,
} from "./prices/sync";
export { type Resolution, type ResolvedPayer, resolvePayers } from "./resolve";
export { type FetchText, httpText, postSlack } from "./slack";

/** A model_call row as stored: the call plus who made it and under which operation. */
export type ModelCallRow = typeof schema.model_call.$inferInsert;

/** A priced row and the payer scope it ran under; null when it ran under none. */
export interface PendingCall {
  readonly row: ModelCallRow;
  readonly payer: Payer | null;
}

/** Unsaved spend of one payer in one UTC second (a downgrade splits periods at any instant). */
export interface SpendBucket {
  readonly payer: Payer;
  readonly second: Date;
  readonly costMicroEur: number;
}

export interface ModelCallSink {
  /** Rows and spend in one transaction: both land or neither does. */
  write(batch: readonly PendingCall[], spend: ReadonlyMap<string, SpendBucket>): Promise<void>;
}

export interface RecorderOptions {
  readonly sink: ModelCallSink;
  readonly logger: Logger;
  /** The process making the calls: echo-api or echo-worker. */
  readonly service: string;
  readonly prices: Pick<PriceBook, "current">;
  /** How long rows wait for company before one insert writes them all. */
  readonly flushMs?: number;
  /** Rows kept while the database is unreachable; older ones are dropped beyond this. */
  readonly maxPending?: number;
  /** Where a model priced without a row is posted, once per model per process; unset is off. */
  readonly slackUrl?: string | null;
}

export interface ModelCallRecorder {
  readonly observe: ModelCallObserver;
  /** Writes what is pending now; the app calls it once before it exits. */
  flush(): Promise<void>;
}

const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_MAX_PENDING = 2000;
// An exit flush retries this often for calls that arrived during the write before it.
const MAX_FLUSH_ROUNDS = 5;
const SECOND_MS = 1000;

/** A row waiting to be written; `unpriced` holds the call until a price book has prices. */
interface Entry {
  row: ModelCallRow;
  readonly payer: Payer | null;
  unpriced: ModelCall | null;
}

/**
 * Hears every model call, logs one line for it at once (Loki and Cloud Logging read
 * that), prices it, and writes rows plus each payer's spend in small batches. A failing
 * database never fails a model call: rows are kept up to the cap, spend is never dropped.
 */
export function modelCallRecorder(opts: RecorderOptions): ModelCallRecorder {
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  const maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
  let queue: Entry[] = [];
  let spend = new Map<string, SpendBucket>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | undefined;
  let failing = false;
  let waitingWarned = false;
  let dropped = 0;
  const unscoped = new Set<string | null>();
  const unpricedModels = new Set<string>();

  const warnUnpriced = (call: ModelCall) => {
    const model = `${call.provider}/${call.model}`;
    if (unpricedModels.has(model)) return;
    unpricedModels.add(model);
    opts.logger.error(
      { model, signal: "metering.price_missing" },
      "model call priced without an AI price",
    );
    void postSlack(
      opts.slackUrl ?? null,
      `No AI price for ${model} (${opts.service}). Its calls are charged at the highest price held until it has one in prices/overrides.json or models.dev.`,
      opts.logger,
    );
  };

  const addSpend = (key: string, b: SpendBucket) => {
    const had = spend.get(key);
    spend.set(key, had ? { ...had, costMicroEur: had.costMicroEur + b.costMicroEur } : b);
  };

  // False while the book is empty and the call has usage to charge: never write a cost from no prices.
  const price = (e: Entry): boolean => {
    const call = e.unpriced;
    if (!call) return true;
    const snap = opts.prices.current();
    const cost = priceCall(call, snap);
    if (cost.priceMissing && snap.prices.size === 0) return false;
    if (cost.priceMissing) warnUnpriced(call);
    e.row = {
      ...e.row,
      cost_micro_eur: cost.costMicroEur,
      price_id: cost.priceId,
      price_missing: cost.priceMissing,
    };
    e.unpriced = null;
    if (e.payer && cost.costMicroEur > 0) {
      const second = new Date(Math.floor(call.startedAt.getTime() / SECOND_MS) * SECOND_MS);
      addSpend(`${payerKey(e.payer)}|${second.toISOString()}`, {
        payer: e.payer,
        second,
        costMicroEur: cost.costMicroEur,
      });
    }
    return true;
  };
  // A book that throws leaves the call waiting, never lost.
  const tryPrice = (e: Entry): boolean => {
    try {
      return price(e);
    } catch {
      return false;
    }
  };

  // Oldest first out, so what is kept is the most recent picture; their spend stays.
  const cap = () => {
    if (queue.length <= maxPending) return;
    dropped += queue.length - maxPending;
    queue = queue.slice(-maxPending);
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushMs);
    // A pending batch never keeps a finished process alive; the app flushes on exit.
    (timer as { unref?: () => void }).unref?.();
  };

  // True when something was written.
  const writeOnce = async (): Promise<boolean> => {
    const taken = queue;
    queue = [];
    const ready: Entry[] = [];
    const waiting: Entry[] = [];
    for (const e of taken) (tryPrice(e) ? ready : waiting).push(e);
    if (waiting.length && !waitingWarned)
      opts.logger.warn({ waiting: waiting.length }, "model calls wait for AI prices");
    waitingWarned = waiting.length > 0;
    if (!ready.length && !spend.size) {
      queue = [...waiting, ...queue];
      return false;
    }
    const sending = spend;
    spend = new Map();
    try {
      await opts.sink.write(
        ready.map((e) => ({ row: e.row, payer: e.payer })),
        sending,
      );
      queue = [...waiting, ...queue];
      if (failing) opts.logger.info({ rows: ready.length }, "model call rows write again");
      failing = false;
      return true;
    } catch (err) {
      queue = [...taken, ...queue];
      for (const [k, b] of sending) addSpend(k, b);
      if (!failing)
        opts.logger.warn(
          { err, pending: queue.length, max: maxPending },
          "model call rows could not be written; kept for the next flush",
        );
      failing = true;
      return false;
    }
  };

  const pending = () => queue.length > 0 || spend.size > 0;

  // One write, or the one already running.
  const round = (): Promise<boolean> => {
    if (inFlight) return inFlight;
    if (!pending()) return Promise.resolve(false);
    inFlight = writeOnce()
      .catch((err) => {
        opts.logger.warn({ err }, "model call rows could not be prepared");
        return false;
      })
      .finally(() => {
        cap();
        if (dropped) {
          opts.logger.error({ dropped, max: maxPending }, `dropped ${dropped} model call rows`);
          dropped = 0;
        }
        inFlight = undefined;
        // Rows waiting for prices or for the database get another try without a new call.
        if (pending()) schedule();
      });
    return inFlight;
  };

  // Writes until nothing is pending, a write fails, or only calls waiting for prices are left;
  // never returns while a write (its own or another flush's) is still running.
  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    for (let i = 0; i < MAX_FLUSH_ROUNDS && (pending() || inFlight); i++) {
      const joined = inFlight !== undefined;
      if (!(await round()) && !joined) break;
    }
    while (inFlight) await inFlight;
  };

  const observe: ModelCallObserver = (call: ModelCall) => {
    const c = correlation();
    const operation = c?.operation ?? null;
    const scope = payer() ?? null;
    opts.logger.info(
      {
        signal: "model.call",
        group: call.group,
        provider: call.provider,
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
        cached_input_tokens: call.cachedInputTokens,
        audio_input_tokens: call.audioInputTokens,
        output_tokens: call.outputTokens,
        reasoning_tokens: call.reasoningTokens,
        audio_seconds: call.audioSeconds,
        search_queries: call.searchQueries,
        usage_estimated: call.usageEstimated,
      },
      "model call",
    );
    if (!scope && !unscoped.has(operation)) {
      unscoped.add(operation);
      opts.logger.warn({ operation, group: call.group }, "model call without a payer");
    }
    const entry: Entry = {
      row: toRow(call, opts.service, operation, c?.requestId ?? null),
      payer: scope,
      unpriced: call,
    };
    queue.push(entry);
    cap();
    tryPrice(entry);
    schedule();
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
    provider: call.provider,
    model: call.model,
    kind: call.kind,
    status: call.status,
    error: call.error,
    finish_reason: call.finishReason,
    attempt: call.attempt,
    fallback: call.fallback,
    ms: call.ms,
    input_tokens: call.inputTokens,
    cached_input_tokens: call.cachedInputTokens,
    audio_input_tokens: call.audioInputTokens,
    output_tokens: call.outputTokens,
    reasoning_tokens: call.reasoningTokens,
    audio_seconds: call.audioSeconds,
    search_queries: call.searchQueries,
    usage_estimated: call.usageEstimated,
  };
}

const RESOLVE_TTL_MS = 60_000;
// Well under Postgres's 65,535 bind parameters per statement at ~30 columns a row.
const INSERT_CHUNK = 1000;

function attribution(r: Resolution) {
  if (r === "internal")
    return { payer: "internal", billing_account_id: null, project_id: null, counted: false };
  if (!r)
    return { payer: "unattributed", billing_account_id: null, project_id: null, counted: false };
  return {
    payer: "account",
    billing_account_id: r.accountId,
    project_id: r.projectId,
    counted: r.counted,
  };
}

/** The production sink: resolves payers, inserts the rows and adds spend in one transaction. */
export function modelCallTable(db: Db): ModelCallSink {
  const cache = new Map<string, { value: Resolution; until: number }>();

  const resolve = async (tx: Db, payers: readonly Payer[]) => {
    const now = Date.now();
    for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
    const missing = payers.filter((p) => !cache.has(payerKey(p)));
    if (missing.length) {
      const found = await resolvePayers(tx, missing);
      for (const [k, value] of found) cache.set(k, { value, until: now + RESOLVE_TTL_MS });
    }
    return (p: Payer | null): Resolution => (p ? (cache.get(payerKey(p))?.value ?? null) : null);
  };

  return {
    async write(batch, spend) {
      if (!batch.length && !spend.size) return;
      await db.transaction(async (raw) => {
        // The transaction lacks Db's $client and batch, so it is not structurally a Db.
        const tx = raw as unknown as Db;
        const payers = [
          ...batch.flatMap((p) => (p.payer ? [p.payer] : [])),
          ...[...spend.values()].map((b) => b.payer),
        ];
        const who = await resolve(tx, payers);

        const rows = batch.map((p) => ({ ...p.row, ...attribution(who(p.payer)) }));
        for (let i = 0; i < rows.length; i += INSERT_CHUNK)
          await tx.insert(schema.model_call).values(rows.slice(i, i + INSERT_CHUNK));

        // One sum per account and period; sorted so concurrent writers lock rows in one order.
        const sums = new Map<string, { accountId: string; period: string; amount: number }>();
        for (const b of spend.values()) {
          const r = who(b.payer);
          if (!r || r === "internal" || !r.counted || b.costMicroEur <= 0) continue;
          const period = periodStart(b.second, r.tier, r.downgradedAt).toISOString();
          const key = `${r.accountId}|${period}`;
          const had = sums.get(key);
          sums.set(key, {
            accountId: r.accountId,
            period,
            amount: (had?.amount ?? 0) + b.costMicroEur,
          });
        }
        if (!sums.size) return;
        const t = schema.free_usage;
        await tx
          .insert(t)
          .values(
            [...sums.entries()]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([, s]) => ({
                billing_account_id: s.accountId,
                period_start: s.period,
                key: AI_SPEND_KEY,
                amount: s.amount,
              })),
          )
          .onConflictDoUpdate({
            target: [t.billing_account_id, t.period_start, t.key],
            set: { amount: sql`${t.amount} + excluded.amount`, updated_at: sql`now()` },
          });
      });
    },
  };
}
