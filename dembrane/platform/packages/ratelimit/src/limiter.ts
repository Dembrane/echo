import { ForbiddenError, RateLimitedError } from "@dembrane/core";

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

  async check(limit: Limit, identifier: string): Promise<void> {
    if (!(await this.allow(limit, identifier))) throw new RateLimitedError("rate_limit.exceeded");
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
    if (!identifier) return true;
    try {
      const count = await this.counter.hit(
        `${limit.name}:${identifier}`,
        limit.windowSeconds,
        this.clock(),
      );
      return count <= limit.capacity;
    } catch (err) {
      this.onError(err, limit);
      return true;
    }
  }
}
