import type { Json, OutboxEvent } from "./contracts";
import { dispatch, type ExecutorDeps } from "./executor";
import type { SnapshotHook } from "./snapshots";
import type { AnalysisStore } from "./store";

/**
 * Dispatch of committed publication events. Publication writes an analysis_outbox row in
 * the transaction that makes an output current, and now also enqueues the dispatch
 * workflow in that same transaction, so a committed publication is always dispatched;
 * the minute sweep remains for events whose consumers failed and are due again, and for
 * dead events' internal effects. Consumers run in order and each is recorded on the
 * event once it succeeds, so a repeated dispatch skips what already happened.
 */

export const MAX_ATTEMPTS = 12;
export const CLAIM_SECONDS = 120;
export const SWEEP_LIMIT = 50;
/** A queued run nobody claimed for this long is sent to a worker again. */
export const QUEUED_REDISPATCH_SECONDS = 120;

export const backoffSeconds = (attempts: number) =>
  Math.trunc(Math.min(3600, 15 * 2 ** Math.max(0, attempts - 1)));

export interface OutboxDeps {
  readonly executor: ExecutorDeps;
  readonly snapshotHooks: readonly SnapshotHook[];
}

export interface DispatchReport {
  claimed: number;
  delivered: number;
  retried: number;
  lost: number;
}

export interface SweepReport {
  expiredRuns: number;
  wokenRuns: number;
  failedWaitingRuns: number;
  redispatchedRuns: number;
  events: DispatchReport;
  deadEvents: DispatchReport;
}

const EVENT_FIELDS = [
  "recipeId",
  "scopeKey",
  "viewId",
  "manifestHash",
  "objectId",
  "revisionId",
  "membershipExcluded",
];

export function eventDoc(event: OutboxEvent): Json {
  return {
    type: event.eventType,
    event_id: event.id,
    scope_id: event.scopeId,
    sequence: event.sequence,
    run_id: event.runId,
    snapshot_id: event.snapshotId,
    ...Object.fromEntries(Object.entries(event.payload).filter(([k]) => EVENT_FIELDS.includes(k))),
  };
}

type Consumer = (event: OutboxEvent, store: AnalysisStore, deps: OutboxDeps) => Promise<void>;

const consumeLiveEvent: Consumer = async (event, _store, deps) => {
  await deps.executor.publishEvent(event.projectId, eventDoc(event));
};

const consumeWakeWaiting: Consumer = async (event, store, deps) => {
  if (event.eventType !== "run_published") return;
  const result = await store.wakeWaitingRuns(event.projectId);
  for (const run of result.woken) {
    await dispatch(deps.executor, run);
    await deps.executor.publishEvent(run.projectId, {
      type: "queued",
      run_id: run.id,
      recipe_id: run.recipeId,
    });
  }
  for (const run of result.failed)
    await deps.executor.publishEvent(run.projectId, {
      type: "failed",
      run_id: run.id,
      recipe_id: run.recipeId,
    });
};

const consumeViewSnapshots: Consumer = async (event, store, deps) => {
  for (const hook of deps.snapshotHooks) await hook(event, store);
};

export const CONSUMERS: readonly (readonly [string, Consumer])[] = [
  ["live_event", consumeLiveEvent],
  ["wake_waiting", consumeWakeWaiting],
  ["view_snapshots", consumeViewSnapshots],
];
/** Effects inside the platform, reconciled even after an event is dead. */
export const INTERNAL_CONSUMERS = ["wake_waiting", "view_snapshots"];

/**
 * Claims due events (or the one named) and runs each consumer not yet done. A failing
 * consumer is retried with its event later while the others still run and are recorded.
 */
export async function dispatchEvents(
  store: AnalysisStore,
  deps: OutboxDeps,
  o: {
    claim: string;
    eventId?: string | null;
    limit?: number;
    consumers?: readonly (readonly [string, Consumer])[];
    dead?: boolean;
  },
): Promise<DispatchReport> {
  const events = await store.claimOutbox({
    claim: o.claim,
    limit: o.limit ?? SWEEP_LIMIT,
    claimSeconds: CLAIM_SECONDS,
    eventId: o.eventId ?? null,
    dead: o.dead ?? false,
  });
  const report: DispatchReport = { claimed: events.length, delivered: 0, retried: 0, lost: 0 };
  for (const event of events) {
    try {
      const failures: string[] = [];
      let lost = false;
      for (const [name, consumer] of o.consumers ?? CONSUMERS) {
        if (name in event.consumers) continue;
        try {
          await consumer(event, store, deps);
        } catch (err) {
          const e = err as Error;
          failures.push(
            `${e?.constructor?.name ?? "Error"}: ${String(e?.message ?? err).slice(0, 300)} (consumer ${name})`,
          );
          deps.executor.logger?.warn(
            {
              event_id: event.id,
              event_type: event.eventType,
              consumer: name,
              attempt: event.attempts,
            },
            "analysis outbox consumer failed",
          );
          continue;
        }
        if (!(await store.markConsumerDone(event.id, o.claim, name))) {
          lost = true;
          break;
        }
      }
      if (lost) {
        // Another dispatcher reclaimed it after our claim expired.
        report.lost++;
        continue;
      }
      if (failures.length) {
        await store.retryOutbox(event.id, o.claim, {
          error: failures.join("; "),
          delaySeconds: backoffSeconds(event.attempts),
          maxAttempts: MAX_ATTEMPTS,
        });
        report.retried++;
        continue;
      }
      if (!(await store.finishOutbox(event.id, o.claim))) {
        report.lost++;
        continue;
      }
      report.delivered++;
    } catch (err) {
      // The claim expires and a later dispatch picks the event up again.
      deps.executor.logger?.warn(
        { event_id: event.id, err: { name: (err as Error)?.name } },
        "outbox event not settled",
      );
      report.lost++;
    }
  }
  return report;
}

/**
 * The minute job: fail runs whose lease deadline passed, settle waiting runs, send
 * stranded queued runs again, dispatch every due event, then finish the internal effects
 * of events already dead.
 */
export async function sweep(
  store: AnalysisStore,
  deps: OutboxDeps,
  claim: string,
): Promise<SweepReport> {
  const expired = await store.expireStaleRuns();
  const wake = await store.wakeWaitingRuns(null);
  const stranded = await store.redispatchQueuedRuns(QUEUED_REDISPATCH_SECONDS, SWEEP_LIMIT);
  for (const run of [...wake.woken, ...stranded]) await dispatch(deps.executor, run);
  const events = await dispatchEvents(store, deps, { claim });
  const deadEvents = await dispatchEvents(store, deps, {
    claim: `${claim}:dead`,
    dead: true,
    consumers: CONSUMERS.filter(([name]) => INTERNAL_CONSUMERS.includes(name)),
  });
  return {
    expiredRuns: expired.length,
    wokenRuns: wake.woken.length,
    failedWaitingRuns: wake.failed.length,
    redispatchedRuns: stranded.length,
    events,
    deadEvents,
  };
}
