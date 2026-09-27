import type { RateCounter } from "./limiter";

export class MemoryRateCounter implements RateCounter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowSeconds: number, now: Date): Promise<number> {
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now.getTime()) {
      this.windows.set(key, { count: 1, resetAt: now.getTime() + windowSeconds * 1000 });
      return 1;
    }
    w.count += 1;
    return w.count;
  }
}
