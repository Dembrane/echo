import { ForbiddenError, RateLimitedError } from "@echo/core";

/**
 * Fixed-window request limits, the same counting the old Redis limiter did (the first
 * hit opens a window of `windowSeconds`, hits past `capacity` inside it answer 429).
 * Held in process: there is no Redis, and these limits only stop loops and abuse, so a
 * per-instance count (at most capacity x instances overall) is enough.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly capacity: number,
    readonly windowSeconds: number,
    private readonly clock: () => number = Date.now,
  ) {}

  private hit(key: string): number {
    const now = this.clock();
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size > 10_000) this.sweep(now);
      this.windows.set(key, { count: 1, resetAt: now + Math.ceil(this.windowSeconds) * 1000 });
      return 1;
    }
    w.count += 1;
    return w.count;
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }

  /** Per signed-in user; an empty id is refused like the old user limiter. */
  checkUser(userId: string): void {
    if (!userId) throw new ForbiddenError("Authenticated user required.");
    this.check(userId);
  }

  /** Per any identifier; an empty identifier is not limited. */
  check(identifier: string): void {
    if (!identifier) return;
    if (this.hit(identifier) > this.capacity)
      throw new RateLimitedError("Too many requests. Try again later.");
  }
}
