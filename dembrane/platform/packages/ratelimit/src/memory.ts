import type { RateCounter } from "./limiter";

/**
 * Fixed windows in process memory, with the Postgres counter's semantics. Bounded: expired
 * windows are swept once the map reaches `maxKeys`, and a key arriving while it is still
 * full goes uncounted. A flood of distinct keys already walks past any per-key limit, so
 * refusing to track more of them loosens nothing and keeps the process's memory flat.
 */
export class MemoryRateCounter implements RateCounter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxKeys = 100_000) {}

  async hit(key: string, windowSeconds: number, now: Date): Promise<number> {
    const t = now.getTime();
    const w = this.windows.get(key);
    if (w && w.resetAt > t) {
      w.count += 1;
      return w.count;
    }
    if (!w && this.windows.size >= this.maxKeys) {
      for (const [k, v] of this.windows) if (v.resetAt <= t) this.windows.delete(k);
      if (this.windows.size >= this.maxKeys) return 1;
    }
    this.windows.set(key, { count: 1, resetAt: t + windowSeconds * 1000 });
    return 1;
  }

  /** Keys currently held; for tests. */
  get size(): number {
    return this.windows.size;
  }
}
