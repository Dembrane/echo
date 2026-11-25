import {
  improves,
  type LlmSettings,
  type ModelHooks,
  type Models,
  speechModels,
  type TranscriptionProfile,
} from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import {
  DEFAULT_RETRY,
  editSentences,
  type FinalTranscriber,
  GeminiFinal,
  GeminiTranscriber,
  requestLimits,
  WhisperFinal,
} from "@dembrane/transcription";
import type { FinalSettings } from "./pipeline/final";
import type { SpeechKit } from "./speech";

/**
 * The speech kit of one transcription profile: the live transcriber and, when the worker
 * asks, the whole pipeline after a recording (the final pass, the clean-up, the redaction).
 * The API builds the light form, which only transcribes and says what the profile improves.
 */
export function buildSpeechKit(o: {
  settings: LlmSettings;
  profile: TranscriptionProfile;
  hooks?: ModelHooks;
  logger: Logger;
  /** Build the final pass too; the worker does, the API does not run it. */
  withFinal: boolean;
  /** LLM_WHISPER_MAX_REQUEST_SECONDS, lowering the live provider's limits. */
  whisperMaxRequestSeconds?: number | undefined;
}): SpeechKit {
  const { profile, settings, logger } = o;
  const models = (provider: "whisper" | "gemini", geminiModel?: string): Models =>
    speechModels(settings, profile, provider, o.hooks ?? {}, geminiModel);
  // The second listen spends the provider's per-minute audio budget again: only the worker,
  // which transcribes the recordings, has it. The API's stateless transcription never did.
  const retry = o.withFinal && profile.live.secondListen ? DEFAULT_RETRY : null;
  const liveModels =
    profile.live.provider === "whisper" ? models("whisper") : models("gemini", profile.live.model);
  const transcriber = new GeminiTranscriber(liveModels, logger, { retry });
  const liveLimits = requestLimits(profile.live.provider);
  const kit = {
    transcriber,
    liveProvider: profile.live.provider,
    improves: { recordings: improves(profile, false), uploads: improves(profile, true) },
    ...(o.whisperMaxRequestSeconds && {
      requestLimits: {
        ...liveLimits,
        maxSeconds: Math.min(liveLimits.maxSeconds, o.whisperMaxRequestSeconds),
      },
    }),
  } satisfies SpeechKit;
  if (!o.withFinal || (profile.recordings === "none" && profile.uploads === "none")) return kit;

  const redoesAnything =
    profile.redo !== null && (profile.recordings === "redo" || profile.uploads === "redo");
  const redoModels =
    redoesAnything && profile.redo
      ? profile.redo.provider === "whisper"
        ? models("whisper")
        : models("gemini", profile.redo.model)
      : null;
  // The clean-up reads Whisper's sentences with the compatible provider's text model.
  const cleanUpModels = profile.cleanUp ? models("whisper") : null;
  const finalTranscriber: FinalTranscriber | null =
    redoModels && profile.redo
      ? profile.redo.provider === "whisper"
        ? new WhisperFinal(redoModels, { retry })
        : new GeminiFinal(redoModels, logger)
      : null;
  const finalProvider = profile.redo?.provider ?? profile.live.provider;
  const final: FinalSettings = {
    profile: profile.name,
    recordings: profile.recordings,
    uploads: profile.uploads,
    timedPieceSeconds: profile.timedPieceSeconds,
    providers: [finalProvider],
    transcribers: finalTranscriber ? { [finalProvider]: finalTranscriber } : {},
    ...(cleanUpModels && {
      edit: {
        providers: ["whisper" as const],
        run: (sentences, ctx) => editSentences(cleanUpModels, sentences, ctx, logger),
      },
    }),
    redact: async (text, r) =>
      (
        await transcriber.redactText({
          text,
          language: r.language,
          usePiiRedaction: true,
          anonymizeTranscripts: true,
          customGuidancePrompt: r.customGuidancePrompt,
          hotwords: r.hotwords,
        })
      ).transcript,
  };
  return { ...kit, final };
}
