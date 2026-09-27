import { RateLimitedError } from "@echo/core";

/**
 * Counts hits per key in fixed windows. `hit` returns the count after this hit; the
 * window starts at the first hit and lasts `windowSeconds`.
 */
export interface RateCounter {
  hit(key: string, windowSeconds: number, now: Date): Promise<number>;
}

export interface Limit {
  /** Stable name; part of the counter key, so renaming it resets every counter. */
  readonly name: string;
  readonly capacity: number;
  readonly windowSeconds: number;
}

/** The body the old API sends on every rate-limit refusal; the frontend shows it. */
export const TOO_MANY = "Too many requests. Try again later.";

/**
 * Rate limits the way the old API applied them: the hit counts even when it is refused,
 * and the (capacity + 1)th hit inside a window answers 429.
 */
export class RateLimiter {
  constructor(
    private readonly counter: RateCounter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async check(limit: Limit, identifier: string): Promise<void> {
    if (!(await this.allow(limit, identifier))) throw new RateLimitedError(TOO_MANY);
  }

  /** False when over capacity. An empty identifier is never limited. */
  async allow(limit: Limit, identifier: string): Promise<boolean> {
    if (!identifier) return true;
    const count = await this.counter.hit(
      `${limit.name}:${identifier}`,
      limit.windowSeconds,
      this.clock(),
    );
    return count <= limit.capacity;
  }
}
