import {
  allowanceForCountedProject,
  freeLimitError,
  freeLimits,
  giveBack,
  take,
} from "@dembrane/allowance";
import type { Db } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";

// Counts one free map per period; given back when start throws or starts nothing new.
export async function startFreeMap<T>(
  db: Db,
  projectId: string,
  now: Date,
  start: () => Promise<{ row: T; started: boolean }>,
  opts: { logger?: Logger | undefined; pending?: () => Promise<T | null> } = {},
): Promise<T> {
  const { logger, pending } = opts;
  const a = await allowanceForCountedProject(db, projectId, now);
  if (!a) return (await start()).row;
  // Free only: work already in flight answers without counting.
  const inFlight = pending ? await pending() : null;
  if (inFlight !== null) return inFlight;
  const limits = await freeLimits(db, () => now);
  const took = await take(db, a, "maps", 1, limits.maps_month);
  if (!took.ok) throw freeLimitError("map", { used: took.used, cap: took.limit });
  let out: { row: T; started: boolean };
  try {
    out = await start();
  } catch (err) {
    // The start's own error is what the caller needs; a failed give-back is only logged.
    await giveBack(db, a, "maps", 1).catch((e) =>
      logger?.error({ err: e, project_id: projectId }, "free map not given back"),
    );
    throw err;
  }
  if (!out.started) await giveBack(db, a, "maps", 1);
  return out.row;
}
