import { newId } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";
import { pyIso } from "./py";
import { isPopcornLoop, type PopcornFlags } from "./service";
import { FINISH_TICK, popcornStore, type Sql } from "./storage";

/**
 * A conversation's transcript is complete: the project's popcorn reads it once. The read
 * is a popcorn_tick row booked FINISH_WINDOW_MS out, so conversations finishing close
 * together share it; the worker's minute claim of due rows starts it with the row's request
 * id, and the tick's run lock serialises it with any other read of the loop. It runs whether
 * or not the loop is live and never changes the mode or the live window.
 */

/** Finishes this close together share one read. */
export const FINISH_WINDOW_MS = 60_000;

/**
 * Books the read for the project's popcorn loop, unless one is already waiting. Runs in
 * the caller's transaction (the claim that marks the transcript complete). Returns whether
 * a read was booked.
 */
export async function queueFinishRead(tx: Sql, projectId: string, now: Date): Promise<boolean> {
  const store = popcornStore(tx);
  const report = await store.popcornReport(projectId);
  if (!report) return false;
  const loop = await store.loopForReport(String(report.id));
  if (!loop || !isPopcornLoop(loop)) return false;
  const loopId = String(loop.id);
  // Two transcripts completing at once would both see no waiting read.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`popcorn:finish-read:${loopId}`}, 0))`;
  if (await store.hasPendingFinishRead(loopId)) return false;
  await store.scheduleTick({
    id: newId(),
    payload: { loop_id: loopId, tick_kind: FINISH_TICK, request_id: newId() },
    scheduledAt: pyIso(new Date(now.getTime() + FINISH_WINDOW_MS)),
    now: pyIso(now),
  });
  return true;
}

/**
 * The conversation pipeline's hook, composed in the worker. A failure is logged and leaves
 * the conversation's finalize alone: the next finish or a host's Analyse reads it.
 */
export function finishReads(deps: {
  readonly flags: PopcornFlags;
  readonly logger: Logger;
  readonly now?: () => Date;
}) {
  return async (
    tx: postgres.TransactionSql,
    projectId: string,
    conversationId: string,
  ): Promise<void> => {
    if (!deps.flags.present && !deps.flags.canvas) return;
    try {
      // A savepoint, so a failed booking does not abort the claim's transaction.
      await tx.savepoint((sp) =>
        queueFinishRead(sp, projectId, (deps.now ?? (() => new Date()))()),
      );
    } catch (err) {
      deps.logger.warn(
        { project_id: projectId, conversation_id: conversationId, err: (err as Error).message },
        "popcorn finish read not booked",
      );
    }
  };
}
