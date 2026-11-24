import { type ProviderId, type RouteDecision, routed } from "@dembrane/llm";
import type { Payer } from "@dembrane/observability";
import type { RequestLimits, SpeechProvider, Transcriber } from "@dembrane/transcription";
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

/** Runs `fn` with the transcriber of the payer's provider, inside the routing scope the call log reads. */
export async function withTranscriber<T>(
  router: SpeechRouter | undefined,
  who: Payer,
  fallback: Transcriber,
  fn: (transcriber: Transcriber) => Promise<T>,
): Promise<T> {
  const picked = router ? await speechKit(router, who) : null;
  return picked ? routed(picked.decision, () => fn(picked.kit.transcriber)) : fn(fallback);
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
