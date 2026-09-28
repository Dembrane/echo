import { pyRound } from "@dembrane/legacy-shape";
import type { StatsStore } from "./storage";

export interface PublicStats {
  projects_count: number;
  conversations_count: number;
  hours_recorded: number;
}

/** Aggregate platform numbers for the public website; staff projects are left out. */
export async function computeStats(store: StatsStore): Promise<PublicStats> {
  const projectIds = await store.countedProjectIds(await store.adminUserIds());
  const { count, seconds } = await store.conversationTotals(projectIds);
  return {
    projects_count: projectIds.length,
    conversations_count: count,
    hours_recorded: pyRound(seconds / 3600),
  };
}

/**
 * One cached value for an hour, computed by one caller at a time: concurrent misses wait
 * for the computation in flight instead of each querying the database.
 */
export class StatsCache {
  private value: { stats: PublicStats; until: number } | null = null;
  private inFlight: Promise<PublicStats> | null = null;

  constructor(
    private readonly compute: () => Promise<PublicStats>,
    private readonly ttlMs = 3_600_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(): Promise<PublicStats> {
    if (this.value && this.value.until > this.clock()) return this.value.stats;
    if (!this.inFlight)
      this.inFlight = this.compute()
        .then((stats) => {
          this.value = { stats, until: this.clock() + this.ttlMs };
          return stats;
        })
        .finally(() => {
          this.inFlight = null;
        });
    return this.inFlight;
  }
}
