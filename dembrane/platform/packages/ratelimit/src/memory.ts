import type { RateCounter, RateWindow } from "./limiter";

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
    return (await this.hitWindow(key, windowSeconds, now)).count;
  }

  async hitWindow(key: string, windowSeconds: number, now: Date): Promise<RateWindow> {
    const t = now.getTime();
    const fresh = { count: 1, resetAt: new Date(t + windowSeconds * 1000) };
    const w = this.windows.get(key);
    if (w && w.resetAt > t) {
      w.count += 1;
      return { count: w.count, resetAt: new Date(w.resetAt) };
    }
    if (!w && this.windows.size >= this.maxKeys) {
      for (const [k, v] of this.windows) if (v.resetAt <= t) this.windows.delete(k);
      if (this.windows.size >= this.maxKeys) return fresh;
    }
    this.windows.set(key, { count: 1, resetAt: fresh.resetAt.getTime() });
    return fresh;
  }

  /** Keys currently held; for tests. */
  get size(): number {
    return this.windows.size;
  }
}
