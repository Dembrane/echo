import { planPieces } from "@dembrane/audio";
import { PROVIDERS, type ProviderId, type RouteDecision, rerouted, routed } from "@dembrane/llm";
import type { Payer } from "@dembrane/observability";
import {
  pieceSeconds,
  type RequestLimits,
  type RetryStats,
  requestLimits,
  type SpeechProvider,
  type TimedText,
  type TranscribeInput,
  type TranscribeResult,
  type Transcriber,
} from "@dembrane/transcription";
import type { FinalSettings } from "./pipeline/final";

/**
 * Everything one AI provider does for a conversation's audio: who writes the live text, how
 * long a request may be, what runs after the recording ends. The Scaleway kit is Whisper,
 * the improved transcript and its clean-up; the Google kit is Gemini and nothing after.
 */
export interface SpeechKit {
  readonly transcriber: Transcriber;
  readonly liveProvider?: SpeechProvider | undefined;
  readonly requestLimits?: RequestLimits | undefined;
  readonly final?: FinalSettings | undefined;
  /** What this kit improves once a conversation ends: recorded ones, uploaded ones. */
  readonly improves: { readonly recordings: boolean; readonly uploads: boolean };
}

/**
 * Picks the kit of the provider a payer resolves to, at the moment of the call: a project
 * that goes back to Scaleway is on Whisper for the very next piece of audio, and a
 * conversation that began on Scaleway stays there when its project moves to Google.
 */
export interface SpeechRouter {
  readonly kits: Readonly<Partial<Record<ProviderId, SpeechKit>>>;
  readonly default: ProviderId;
  decide(who: Payer): Promise<RouteDecision>;
}

/** The kit for a payer and the decision that chose it. */
export async function speechKit(
  router: SpeechRouter,
  who: Payer,
): Promise<{ kit: SpeechKit; decision: RouteDecision } | null> {
  const decision = await router.decide(who);
  const kit = router.kits[decision.provider] ?? router.kits[router.default];
  return kit ? { kit, decision } : null;
}

/** What one request to this kit's live provider may carry: its own limits, else its provider's. */
export const kitLimits = (kit: SpeechKit): RequestLimits =>
  kit.requestLimits ?? requestLimits(kit.liveProvider ?? "whisper");

/**
 * A transcriber for a payer's calls: each runs on the kit of `first`'s provider and, while that
 * provider needs an opt-in, decides again before every attempt after the first (a retry, the
 * next deployment, the next model group, the redaction pass). A payer that no longer resolves
 * to that provider has the call run again from the start on the kit of its new provider, with
 * the new decision in the call log: a piece that began on Gemini and meets a rate limit after
 * the project moved back to Scaleway is transcribed by Whisper, split to Whisper's limits when
 * it is too large for one request.
 */
export function followingTranscriber(
  router: SpeechRouter,
  who: Payer,
  first: RouteDecision,
): Transcriber {
  const via = <T>(call: (kit: SpeechKit, moved: boolean) => Promise<T>) =>
    rerouted(
      first,
      () => router.decide(who),
      async (at) => {
        const kit = router.kits[at.provider] ?? router.kits[router.default];
        if (!kit) throw new Error(`no speech kit for provider ${at.provider}`);
        return call(kit, at.provider !== first.provider);
      },
    );
  return {
    transcribe: (input) => via((kit, moved) => transcribeWithin(kit, input, moved)),
    redactText: (input) => via((kit) => kit.transcriber.redactText(input)),
  };
}

/**
 * One piece of audio on the kit that runs it. The piece was cut for the kit that was current
 * when it was made; after a move it may be larger than this kit's request takes, and a request
 * over the limit is refused on every retry. Such a piece is cut again, at its pauses, to this
 * kit's limits and read in parts, the parts' text and times put back together.
 */
async function transcribeWithin(
  kit: SpeechKit,
  input: TranscribeInput,
  moved: boolean,
): Promise<TranscribeResult> {
  const limits = kitLimits(kit);
  const oversize = input.audio.byteLength > limits.maxBytes;
  if ((!moved && !oversize) || !input.pauses || !input.cutSpan)
    return kit.transcriber.transcribe(input);
  let measured: Awaited<ReturnType<NonNullable<TranscribeInput["pauses"]>>>;
  try {
    measured = await input.pauses();
  } catch {
    // Without a measurement the piece goes as it is.
    return kit.transcriber.transcribe(input);
  }
  // An upload whose improved transcript is its own first reading is read in short pieces for the sentence times.
  const timedCap =
    input.priority === "upload" && kit.final?.uploads === "first-pass"
      ? (kit.final.timedPieceSeconds ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
  const longest = pieceSeconds(limits, input.audio.byteLength, measured.duration, timedCap);
  if (!(measured.duration > longest)) return kit.transcriber.transcribe(input);
  const cut = input.cutSpan;
  const results: { start: number; duration: number; result: TranscribeResult }[] = [];
  for (const piece of planPieces(measured.duration, measured.silences, longest)) {
    const part: TranscribeInput = {
      ...input,
      audio: await cut(piece.start, piece.start + piece.duration),
      // A retry of a doubtful stretch inside the part cuts from the whole piece's audio.
      cutSpan: (a, b) => cut(piece.start + a, piece.start + b),
    };
    // The whole piece's pauses are not the part's.
    delete (part as { pauses?: unknown }).pauses;
    results.push({
      start: piece.start,
      duration: piece.duration,
      result: await kit.transcriber.transcribe(part),
    });
  }
  return joinParts(results, measured.duration);
}

/** The parts of one piece read separately, as the one reading of the whole piece. */
function joinParts(
  parts: readonly { start: number; duration: number; result: TranscribeResult }[],
  seconds: number,
): TranscribeResult {
  const retried = parts.flatMap((p) => (p.result.retry ? [p.result.retry] : []));
  const retry: RetryStats | undefined = retried.length
    ? retried.reduce((t, r) => ({
        spans: t.spans + r.spans,
        attempts: t.attempts + r.attempts,
        improved: t.improved + r.improved,
        kept: t.kept + r.kept,
        failed: t.failed + r.failed,
        seconds: t.seconds + r.seconds,
      }))
    : undefined;
  const timed = parts.every((p) => p.result.segments);
  const segments: TimedText | undefined = timed
    ? {
        seconds,
        sentences: parts.flatMap((p) =>
          (p.result.segments as TimedText).sentences.map((x) => ({
            start: Math.round((x.start + p.start) * 100) / 100,
            end: Math.round((x.end + p.start) * 100) / 100,
            text: x.text,
          })),
        ),
      }
    : undefined;
  return {
    transcript: parts
      .map((p) => p.result.transcript.trim())
      .filter(Boolean)
      .join(" "),
    note: parts
      .map((p) => p.result.note)
      .filter(Boolean)
      .join(" "),
    models: parts.flatMap((p) => p.result.models),
    ...(retry && { retry }),
    ...(segments && { segments }),
  };
}

/** The project of a final pass left the provider the pass began on; nothing more is sent there. */
export class FinalRouteMoved extends Error {
  override name = "FinalRouteMoved";
  readonly isRetryable = false;
  constructor(
    readonly from: ProviderId,
    readonly to: RouteDecision,
  ) {
    super(`the final pass began on ${from}, and the project is on ${to.provider} now`);
  }
}

/**
 * The final pass of a kit, as one conversation's provider may run it. While that provider
 * needs an opt-in, every call of the pass (a piece, its retries and its fallback to the fast
 * model, the clean-up, the redaction) decides again before it is sent, and again before each
 * of its own attempts after the first. Once the payer no longer resolves to that provider the
 * pass sends nothing more there and stops with FinalRouteMoved; the caller finishes the work on
 * the kit of the new provider or leaves the live text.
 */
export function followingFinal(
  router: SpeechRouter,
  who: Payer,
  first: RouteDecision,
  final: FinalSettings,
): FinalSettings {
  if (!PROVIDERS[first.provider].optIn) return final;
  const moved = (to: RouteDecision) => new FinalRouteMoved(first.provider, to);
  const checked = async <T>(call: () => Promise<T>): Promise<T> => {
    const now = await router.decide(who);
    if (now.provider !== first.provider) throw moved(now);
    return rerouted(
      first,
      () => router.decide(who),
      async (at) => {
        if (at.provider !== first.provider) throw moved(at);
        return call();
      },
    );
  };
  return {
    ...final,
    transcribers: Object.fromEntries(
      Object.entries(final.transcribers).map(([name, t]) => [
        name,
        {
          provider: t.provider,
          limits: t.limits,
          // The model that answered is read after a piece: the wrapped transcriber's.
          get model() {
            return t.model;
          },
          transcribe: (input) => checked(() => t.transcribe(input)),
        },
      ]),
    ),
    redact: (text, o) => checked(() => final.redact(text, o)),
    ...(final.edit && {
      edit: {
        providers: final.edit.providers,
        run: (sentences, ctx) =>
          checked(() => (final.edit as NonNullable<FinalSettings["edit"]>).run(sentences, ctx)),
      },
    }),
  };
}

/** Runs `fn` with the transcriber of the payer's provider, inside the routing scope the call log reads. */
export async function withTranscriber<T>(
  router: SpeechRouter | undefined,
  who: Payer,
  fallback: Transcriber,
  fn: (transcriber: Transcriber) => Promise<T>,
): Promise<T> {
  const picked = router ? await speechKit(router, who) : null;
  return router && picked
    ? routed(picked.decision, () => fn(followingTranscriber(router, who, picked.decision)))
    : fn(fallback);
}

/** What the conversation's own provider improves once it ends. */
export async function improvesOf(
  router: SpeechRouter,
  conversationId: string,
): Promise<SpeechKit["improves"] | null> {
  return (
    (await speechKit(router, { ref: "conversation", id: conversationId }))?.kit.improves ?? null
  );
}
