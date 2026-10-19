import type { Models, SpeechPriority } from "@dembrane/llm";

type SpeechToText = NonNullable<Models["speechToText"]>;
type Result = Awaited<ReturnType<SpeechToText["transcribeSegments"]>>;
type Segment = Result["segments"][number];

/**
 * When Whisper doubts itself. Its own confidence rides on every segment: a mean log
 * probability under about -1 means it was guessing, a compression ratio over 2.4 means it was
 * repeating itself. A doubtful stretch is transcribed again on its own, which also moves the
 * 30 second window Whisper decodes in, and the better of the two readings is kept.
 */
export interface RetryPolicy {
  readonly minLogprob: number;
  readonly maxCompression: number;
  /** A segment this likely to be no speech and this unsure is a hallucination on noise, not words. */
  readonly maxNoSpeech: number;
  /** Doubtful segments closer than this many seconds are retried as one span. */
  readonly mergeGap: number;
  /** Seconds added on both sides of a span so the cut never lands inside a word. */
  readonly pad: number;
  readonly minSpan: number;
  readonly maxSpans: number;
  /** The retries of one span, in order. A named language is the one Whisper reported for the span in the first retry. */
  readonly attempts: readonly {
    readonly temperature: number;
    /** auto: Whisper listens; detected: the language it reported for the span; project: the project's language. */
    readonly language: "auto" | "detected" | "project";
    /** Seconds of context added on both sides of the cut; only the span's own words are taken from the reading. */
    readonly pad?: number;
    /** Seconds the cut starts earlier, so Whisper's 30 second window falls elsewhere. */
    readonly shift?: number;
  }[];
  /** At most this share of a piece's seconds is sent again. */
  readonly maxShare: number;
  /**
   * Whisper sometimes stops early on noisy audio, confidently: a 29 second piece comes back with
   * nine seconds of words and a good log probability. A stretch this long with no segment in it is
   * transcribed again, and the new reading is kept only when it holds speech: at least `gapRate`
   * words per second (a hallucination on silence is a few words over a long stretch). 0 turns it off.
   */
  readonly minGap: number;
  readonly gapRate: number;
  /**
   * A piece whose detected language is not the project's is read again in the project's language
   * (far-field English came back as another language, or translated). The new reading still has
   * to win on the signals, so a conversation that really switches language keeps its words.
   */
  readonly language?: boolean;
  /**
   * A window of loud audio with few words: Whisper dropped speech without any sign of doubt.
   * Needs the pauses of the piece (the backend measures them against the piece's own noise floor).
   */
  readonly lowWords?: {
    readonly window: number;
    readonly minSpeech: number;
    readonly maxWps: number;
  } | null;
  /** A reading with this many times the words, no more doubtful and not unsure, wins. 0 turns it off. */
  readonly wordsGain?: number;
  /** Every piece is read twice and the better reading kept: the upper bound of what retries can give. */
  readonly always?: boolean;
}

/**
 * Chosen on human reference text (AMI far-field meetings, VoxPopuli and FLEURS Dutch, read speech):
 * a retry is triggered by a language that is not the project's, a window of speech with few
 * words, or a gap with no words, and is read in the project's language first. Whisper's own
 * confidence adds little on top of these (it is kept for loops: compression ratio over 2.4).
 */
export const DEFAULT_RETRY: RetryPolicy = {
  minLogprob: Number.NEGATIVE_INFINITY,
  maxCompression: 2.4,
  maxNoSpeech: 0.6,
  mergeGap: 1,
  pad: 0.3,
  minSpan: 1,
  maxSpans: 4,
  attempts: [
    { temperature: 0.2, language: "project" },
    { temperature: 0.4, language: "auto" },
  ],
  maxShare: 1,
  minGap: 4,
  gapRate: 0.8,
  language: true,
  lowWords: { window: 4, minSpeech: 0.6, maxWps: 1 },
};

const NAMES: Record<string, string> = {
  english: "en",
  dutch: "nl",
  german: "de",
  french: "fr",
  spanish: "es",
  italian: "it",
  ukrainian: "uk",
  czech: "cs",
};
/** The two letter code of a language Whisper reported or a project names ("English", "en-US"). */
export const isoOf = (l: string) =>
  NAMES[l.trim().toLowerCase()] ?? l.trim().toLowerCase().slice(0, 2);

/** The length of a piece of audio and its pauses, measured by the media service. */
export type Pauser = () => Promise<{
  readonly duration: number;
  readonly silences: readonly { start: number; end: number }[];
}>;

/** Windows of loud audio whose words per second are under the limit. */
export function lowWordSpans(
  segments: readonly Segment[],
  pauses: readonly { start: number; end: number }[],
  total: number,
  c: { window: number; minSpeech: number; maxWps: number },
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let t = 0; t + c.window <= total + 0.01; t += c.window / 2) {
    const e = t + c.window;
    const silent = pauses.reduce(
      (n, p) => n + Math.max(0, Math.min(p.end, e) - Math.max(p.start, t)),
      0,
    );
    if (1 - silent / c.window < c.minSpeech) continue;
    let words = 0;
    for (const s of segments) {
      const o = Math.min(s.end, e) - Math.max(s.start, t);
      if (o > 0)
        words += (s.text.split(/\s+/).filter(Boolean).length * o) / Math.max(0.1, s.end - s.start);
    }
    if (words / c.window < c.maxWps) out.push({ start: t, end: e });
  }
  return out;
}

export interface RetryStats {
  /** Doubtful stretches found. */
  readonly spans: number;
  /** Requests sent again. */
  readonly attempts: number;
  /** Stretches where the new reading replaced the old. */
  readonly improved: number;
  /** Stretches where every retry was worse or no better and Whisper's first reading stayed. */
  readonly kept: number;
  /** Stretches where the retry could not run (cut or request failed). */
  readonly failed: number;
  /** Seconds of audio sent again, for the cost. */
  readonly seconds: number;
}

export const NO_RETRIES: RetryStats = {
  spans: 0,
  attempts: 0,
  improved: 0,
  kept: 0,
  failed: 0,
  seconds: 0,
};

/** Cuts seconds [start, end) out of the audio that was sent. Supplied by whoever has the media service. */
export type SpanCutter = (start: number, end: number) => Promise<Uint8Array>;

export function doubtful(s: Segment, p: RetryPolicy): boolean {
  if (s.avgLogprob !== undefined && s.avgLogprob < p.minLogprob) return true;
  if (s.compressionRatio !== undefined && s.compressionRatio > p.maxCompression) return true;
  return (
    s.noSpeechProb !== undefined &&
    s.noSpeechProb > p.maxNoSpeech &&
    (s.avgLogprob === undefined || s.avgLogprob < p.minLogprob / 2)
  );
}

export interface Span {
  readonly start: number;
  readonly end: number;
  /** Indexes into the segment list; none for a stretch where Whisper wrote nothing at all. */
  readonly indexes: number[];
}

/** The doubtful segments, and the stretches with no segment, as spans: neighbours merged, padded, kept inside the audio. */
export function spansOf(segments: readonly Segment[], p: RetryPolicy, seconds: number): Span[] {
  const out: { start: number; end: number; indexes: number[] }[] = [];
  segments.forEach((s, i) => {
    if (!doubtful(s, p)) return;
    const last = out[out.length - 1];
    if (last && s.start - last.end <= p.mergeGap) {
      last.end = Math.max(last.end, s.end);
      last.indexes.push(i);
    } else out.push({ start: s.start, end: s.end, indexes: [i] });
  });
  if (p.minGap > 0 && seconds > 0) {
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    let cursor = 0;
    const gaps: { start: number; end: number; indexes: number[] }[] = [];
    for (const s of sorted) {
      if (s.start - cursor >= p.minGap) gaps.push({ start: cursor, end: s.start, indexes: [] });
      cursor = Math.max(cursor, s.end);
    }
    if (seconds - cursor >= p.minGap) gaps.push({ start: cursor, end: seconds, indexes: [] });
    out.push(...gaps);
    out.sort((a, b) => a.start - b.start);
  }
  return out
    .map((s) => ({
      ...s,
      start: Math.max(0, s.start - p.pad),
      end: Math.min(seconds, s.end + p.pad),
    }))
    .filter((s) => s.end - s.start >= p.minSpan);
}

/** What the signals say about a reading: how many segments are still doubtful, and how sure the rest is. */
export function quality(segments: readonly Segment[], p: RetryPolicy) {
  const seconds = segments.reduce((t, s) => t + Math.max(0, s.end - s.start), 0) || 1;
  const mean =
    segments.reduce((t, s) => t + (s.avgLogprob ?? -0.5) * Math.max(0, s.end - s.start), 0) /
    seconds;
  return {
    flagged: segments.filter((s) => doubtful(s, p)).length,
    mean,
    words: segments.reduce((t, s) => t + s.text.split(/\s+/).filter(Boolean).length, 0),
  };
}

/**
 * The new reading wins when fewer of its segments are doubtful, or as many and a clearly
 * higher mean confidence. A reading that dropped most of the words wins only over a
 * looping one (compression ratio over the limit), where fewer words is the point.
 */
export function better(
  next: readonly Segment[],
  old: readonly Segment[],
  p: RetryPolicy,
  spanSeconds?: number,
): boolean {
  if (!next.length) return false;
  if (old.length && p.wordsGain) {
    const a = quality(next, p);
    const b = quality(old, p);
    if (a.flagged <= b.flagged && a.words >= b.words * p.wordsGain + 2 && a.mean > p.minLogprob)
      return true;
  }
  if (!old.length) {
    // A stretch that had no words: it must now hold speech, not a few words over a long silence.
    const q = quality(next, p);
    const length =
      spanSeconds ?? Math.max(...next.map((s) => s.end)) - Math.min(...next.map((s) => s.start));
    return q.flagged === 0 && q.words / Math.max(length, 1) >= p.gapRate;
  }
  const a = quality(next, p);
  const b = quality(old, p);
  const looping = old.some((s) => (s.compressionRatio ?? 0) > p.maxCompression);
  if (!looping && a.words < b.words * 0.5) return false;
  if (a.flagged !== b.flagged) return a.flagged < b.flagged;
  return a.mean > b.mean + 0.05;
}

export interface CheckedOptions {
  readonly language?: string | null;
  readonly prompt?: string;
  readonly signal?: AbortSignal;
  /** Who the audio is for, for the provider's rate limit: live goes first. */
  readonly priority?: SpeechPriority;
  /** Seconds of audio in the piece, for the same pacing. */
  readonly seconds?: number;
}

/**
 * One transcription with Whisper's confidence checked: doubtful stretches are transcribed
 * again alone (a few retries, a share of the audio at most) and kept only when the signals
 * say the new reading is better. Every retry is counted. Without a cutter, a policy, or any
 * confidence on the segments, this is a single plain call.
 */
export async function transcribeChecked(
  stt: SpeechToText,
  audio: Uint8Array,
  opts: CheckedOptions,
  seconds: number | undefined,
  cut: SpanCutter | undefined,
  policy: RetryPolicy | null,
  /** More stretches to read again, from a signal Whisper does not give: loudness against words, a language. */
  extra?: (first: Result, seconds: number) => { start: number; end: number }[],
  pauses?: Pauser,
): Promise<{ result: Result; stats: RetryStats }> {
  const first = await stt.transcribeSegments(audio, opts);
  if (!policy || !cut) return { result: first, stats: NO_RETRIES };
  let measured: Awaited<ReturnType<Pauser>> | null = null;
  if (pauses) {
    try {
      measured = await pauses();
    } catch {
      // Without a measurement the pause-based signals are skipped.
    }
  }
  // Whisper's own count of seconds can stop with its words: the length of the audio is what a gap is measured against.
  const total =
    seconds ??
    measured?.duration ??
    first.seconds ??
    Math.max(0, ...first.segments.map((s) => s.end));
  let found: Span[] = policy.always
    ? [{ start: 0, end: total, indexes: first.segments.map((_, i) => i) }]
    : spansOf(first.segments, policy, total);
  const more = extra ? [...extra(first, total)] : [];
  if (policy.language && opts.language && first.language && !policy.always) {
    if (isoOf(first.language) !== isoOf(opts.language)) more.push({ start: 0, end: total });
  }
  if (policy.lowWords && measured && !policy.always)
    more.push(...lowWordSpans(first.segments, measured.silences, total, policy.lowWords));
  if (more.length)
    found = mergeSpans(
      [
        ...found,
        ...more.map((e) => ({
          start: Math.max(0, e.start),
          end: Math.min(total, e.end),
          indexes: first.segments.flatMap((g, i) =>
            (g.start + g.end) / 2 >= e.start && (g.start + g.end) / 2 <= e.end ? [i] : [],
          ),
        })),
      ],
      first.segments,
    );
  const spans = found.slice(0, policy.maxSpans);
  if (!spans.length) return { result: first, stats: NO_RETRIES };

  let budget = total * policy.maxShare * (policy.always ? 3 : 1);
  let attempts = 0;
  let improved = 0;
  let kept = 0;
  let failed = 0;
  let resent = 0;
  const replace = new Map<number, Segment[]>();
  const dropped = new Set<number>();
  const added: Segment[] = [];
  for (const span of spans) {
    const length = span.end - span.start;
    if (length > budget) {
      kept++;
      continue;
    }
    budget -= length;
    const old = span.indexes.map((i) => first.segments[i] as Segment);
    let best: { segments: Segment[]; language?: string } | null = null;
    let detected: string | undefined;
    let ran = false;
    for (const a of policy.attempts) {
      const from = Math.max(0, span.start - (a.pad ?? 0) - (a.shift ?? 0));
      const to = Math.min(total, span.end + (a.pad ?? 0));
      attempts++;
      resent += to - from;
      try {
        const bytes = await cut(from, to);
        const forced =
          a.language === "detected" ? detected : a.language === "project" ? opts.language : null;
        const r = await stt.transcribeSegments(bytes, {
          language: opts.language ?? null,
          ...(opts.signal && { signal: opts.signal }),
          temperature: a.temperature,
          ...(forced && { forceLanguage: isoOf(forced) }),
          ...(opts.priority && { priority: opts.priority }),
          seconds: to - from,
        });
        ran = true;
        detected ??= r.language;
        const wide = from < span.start - 1e-6 || to > span.end + 1e-6;
        const shifted = r.segments
          .map((s) => ({ ...s, start: s.start + from, end: s.end + from }))
          .filter(
            (s) =>
              !wide || ((s.start + s.end) / 2 >= span.start && (s.start + s.end) / 2 <= span.end),
          );
        if (better(shifted, best?.segments ?? old, policy, length)) best = { segments: shifted };
        if (best && quality(best.segments, policy).flagged === 0) break;
      } catch {
        // A failed retry costs nothing: the first reading stays.
      }
    }
    if (!ran) failed++;
    else if (best) {
      improved++;
      if (span.indexes.length === 0) added.push(...best.segments);
      span.indexes.forEach((i, k) => {
        dropped.add(i);
        if (k === 0) replace.set(i, best.segments);
      });
    } else kept++;
  }
  const segments: Segment[] = [];
  first.segments.forEach((s, i) => {
    if (replace.has(i)) segments.push(...(replace.get(i) as Segment[]));
    else if (!dropped.has(i)) segments.push(s);
  });
  segments.push(...added);
  segments.sort((a, b) => a.start - b.start);
  return {
    result: { ...first, segments, text: segments.map((s) => s.text).join(" ") },
    stats: { spans: spans.length, attempts, improved, kept, failed, seconds: resent },
  };
}

/** Spans that touch are one span; the segments inside are the union. */
function mergeSpans(spans: Span[], segments: readonly Segment[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      const end = Math.max(last.end, s.end);
      const inside = segments.flatMap((g, i) =>
        (g.start + g.end) / 2 >= last.start && (g.start + g.end) / 2 <= end ? [i] : [],
      );
      const indexes = [...new Set([...last.indexes, ...s.indexes, ...inside])].sort(
        (a, b) => a - b,
      );
      out[out.length - 1] = { start: last.start, end, indexes };
    } else out.push(s);
  }
  return out.filter((s) => s.end - s.start > 0.5);
}
