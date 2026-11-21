import { ForbiddenError, RateLimitedError } from "@dembrane/core";

/**
 * Counts hits per key in fixed windows. `hit` returns the count after this hit; the
 * window starts at the first hit and lasts `windowSeconds`.
 */
export interface RateCounter {
  hit(key: string, windowSeconds: number, now: Date): Promise<number>;
  /**
   * The same hit, also saying when its window ends. Counters that know it implement this,
   * so a refusal can tell the caller how long to wait; it counts exactly as `hit` does.
   */
  hitWindow?(key: string, windowSeconds: number, now: Date): Promise<RateWindow>;
}

/** A counter's answer to one hit: the count after it, and when the window ends. */
export interface RateWindow {
  readonly count: number;
  readonly resetAt: Date;
}

export interface Limit {
  /** Stable name; part of the counter key, so renaming it resets every counter. */
  readonly name: string;
  readonly capacity: number;
  readonly windowSeconds: number;
}

/** The detail of rate_limit.exceeded: the body the old API sends on every rate-limit refusal. */
export const TOO_MANY = "Too many requests. Try again later.";

/**
 * Rate limits the way the old API applied them: the hit counts even when it is refused,
 * and the (capacity + 1)th hit inside a window answers 429.
 */
export class RateLimiter {
  constructor(
    private readonly counter: RateCounter,
    private readonly clock: () => Date = () => new Date(),
    /** Told when the counter store fails; the request then proceeds unlimited. */
    private readonly onError: (err: unknown, limit: Limit) => void = () => {},
  ) {}

  /**
   * Refuses with rate_limit.exceeded when over capacity. When the counter knows when the
   * window ends, the refusal carries `retry_after_seconds`, so the caller can say how long
   * to wait. Only the report: the limit itself is the same either way.
   */
  async check(limit: Limit, identifier: string): Promise<void> {
    const verdict = await this.consume(limit, identifier);
    if (verdict.allowed) return;
    if (verdict.retryAfterSeconds === undefined) throw new RateLimitedError("rate_limit.exceeded");
    throw new RateLimitedError("rate_limit.exceeded", {
      params: { retry_after_seconds: verdict.retryAfterSeconds },
    });
  }

  /** Per signed-in user; an empty user id is refused, as the old user limiter did. */
  async checkUser(limit: Limit, userId: string): Promise<void> {
    if (!userId) throw new ForbiddenError("auth.user_required");
    await this.check(limit, userId);
  }

  /**
   * False when over capacity. An empty identifier is never limited. A failing counter
   * store fails open: limits guard against abuse, and an outage of their table must not
   * take sign-up, invites and onboarding down with it.
   */
  async allow(limit: Limit, identifier: string): Promise<boolean> {
    return (await this.consume(limit, identifier)).allowed;
  }

  private async consume(
    limit: Limit,
    identifier: string,
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    if (!identifier) return { allowed: true };
    const key = `${limit.name}:${identifier}`;
    const now = this.clock();
    try {
      if (!this.counter.hitWindow) {
        const count = await this.counter.hit(key, limit.windowSeconds, now);
        return { allowed: count <= limit.capacity };
      }
      const w = await this.counter.hitWindow(key, limit.windowSeconds, now);
      if (w.count <= limit.capacity) return { allowed: true };
      // Whole seconds, at least one: a refusal never says "try again in 0 seconds".
      const left = Math.ceil((w.resetAt.getTime() - now.getTime()) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, left) };
    } catch (err) {
      this.onError(err, limit);
      return { allowed: true };
    }
  }
}
