/**
 * Who goes first when Whisper's audio-seconds-per-minute limit is the bottleneck: a person
 * recording now (live), the pass over a finished conversation (final), a long upload (upload).
 * Live goes first and keeps a share of the budget nobody else may take, so a big upload
 * never starves a live session.
 */
export type SpeechPriority = "live" | "final" | "upload";

const RANK: Record<SpeechPriority, number> = { live: 0, final: 1, upload: 2 };

export interface SpeechGateOptions {
  /** Audio seconds the provider takes per minute for this process; 0 turns the pacing off. */
  readonly secondsPerMinute: number;
  /** Requests in flight at once. */
  readonly concurrency?: number;
  /** Share of the minute's budget only live requests may use. */
  readonly liveReserve?: number;
  /** The window the limit is counted over; a minute, shorter only in tests. */
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
  readonly seconds: number;
  readonly priority: SpeechPriority;
  readonly order: number;
  readonly go: () => void;
}

/**
 * Paces calls to a speech-to-text endpoint: a sliding window of the audio seconds sent in the
 * last minute, a cap on requests in flight, priorities, and a pause every caller honours when
 * the provider answers 429.
 */
export class SpeechGate {
  private readonly sent: { at: number; seconds: number; background: boolean }[] = [];
  private readonly waiting: Waiter[] = [];
  private inFlight = 0;
  private pausedUntil = 0;
  private order = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly limit: number;
  private readonly concurrency: number;
  private readonly reserve: number;
  private readonly window: number;
  private readonly now: () => number;

  constructor(opts: SpeechGateOptions) {
    this.limit = opts.secondsPerMinute;
    this.concurrency = opts.concurrency ?? 8;
    this.reserve = opts.liveReserve ?? 0.3;
    this.window = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Runs `fn` once the budget, the concurrency and the priority order allow it. */
  async run<T>(seconds: number, priority: SpeechPriority, fn: () => Promise<T>): Promise<T> {
    if (this.limit <= 0) return fn();
    await new Promise<void>((go) => {
      this.waiting.push({ seconds, priority, order: this.order++, go });
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  /** The provider said slow down: nobody sends before this many milliseconds have passed. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    this.pump();
  }

  /** What the last minute used, for tests and the one log line. */
  used(): number {
    this.expire();
    return this.sent.reduce((t, s) => t + s.seconds, 0);
  }

  private expire() {
    const cutoff = this.now() - this.window;
    while (this.sent.length && (this.sent[0] as { at: number }).at <= cutoff) this.sent.shift();
  }

  private pump() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (;;) {
      const t = this.now();
      if (t < this.pausedUntil) return this.wakeAt(this.pausedUntil);
      if (!this.waiting.length || this.inFlight >= this.concurrency) return;
      this.expire();
      // Best first: live, then final, then upload; each in arrival order.
      this.waiting.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.order - b.order);
      const next = this.waiting[0] as Waiter;
      const used = this.sent.reduce((n, s) => n + s.seconds, 0);
      const background = this.sent.reduce((n, s) => n + (s.background ? s.seconds : 0), 0);
      const budget = next.priority === "live" ? this.limit : this.limit * (1 - this.reserve);
      const usedHere = next.priority === "live" ? used : background;
      // A request bigger than the whole budget still goes when the window is empty.
      if (usedHere > 0 && usedHere + next.seconds > budget) {
        const first = this.sent.find((s) => next.priority === "live" || s.background);
        return this.wakeAt((first?.at ?? t) + this.window + 1);
      }
      this.waiting.shift();
      this.sent.push({ at: t, seconds: next.seconds, background: next.priority !== "live" });
      this.inFlight++;
      next.go();
    }
  }

  private wakeAt(at: number) {
    this.timer = setTimeout(() => this.pump(), Math.max(1, at - this.now()));
  }
}

const gates = new Map<string, SpeechGate>();

/** One gate per endpoint and process, shared by every Models instance that talks to it. */
export function speechGateFor(key: string, opts: SpeechGateOptions): SpeechGate {
  let g = gates.get(key);
  if (!g) {
    g = new SpeechGate(opts);
    gates.set(key, g);
  }
  return g;
}

/** Seconds to wait from a Retry-After header: a number of seconds or an HTTP date. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
