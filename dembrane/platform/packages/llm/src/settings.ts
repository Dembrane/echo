import type { ModelGroup, ModelsConfig } from "./models";
import { profileForProvider, profileOf, type TranscriptionProfile } from "./profiles";
import {
  isProviderId,
  JOBS,
  type PerJob,
  PROVIDERS,
  type ProviderId,
  providerOfKind,
  type RoutingPolicy,
  serves,
} from "./providers";

/** The `llm` section of the platform config, as far as model wiring reads it. */
export interface LlmSettings {
  /** The environment's default provider: where a call goes when nothing says otherwise. */
  readonly provider: "vertex" | "openai-compatible";
  /**
   * The providers this deployment has credentials for (LLM_PROVIDERS). Unset: only the default,
   * which is what every deployment before per-account providers was.
   */
  readonly providers?: readonly string[] | undefined;
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  /** TRANSCRIPTION_PROFILE: the transcription pipeline by name (profiles.ts). */
  readonly transcriptionProfile?: string | undefined;
  readonly transcriptionKeyTerms?: boolean | undefined;
  readonly whisperSecondsPerMinute?: number | undefined;
  readonly whisperConcurrency?: number | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly searchGrounding: boolean;
  readonly textFast: readonly string[];
  readonly multiModalFast: readonly string[];
  readonly multiModalPro: readonly string[];
  readonly compatTextFast: readonly string[];
  readonly compatMultiModalFast: readonly string[];
  readonly compatMultiModalPro: readonly string[];
  readonly vertexProject: string;
  readonly vertexLocation: string;
  readonly embeddingModel: string;
  readonly compatEmbeddingModel: string;
  readonly embeddingLocation: string;
  readonly embeddingDimensions: number;
}

const isCompat = (s: Pick<LlmSettings, "provider">) => s.provider === "openai-compatible";

/** The model ids of each group on the selected provider. */
export function groupsOf(s: LlmSettings): Record<ModelGroup, readonly string[]> {
  return isCompat(s)
    ? {
        text_fast: s.compatTextFast,
        multi_modal_fast: s.compatMultiModalFast,
        multi_modal_pro: s.compatMultiModalPro,
      }
    : {
        text_fast: s.textFast,
        multi_modal_fast: s.multiModalFast,
        multi_modal_pro: s.multiModalPro,
      };
}

/** The embedding model id on the selected provider. */
export const embeddingModelOf = (s: LlmSettings) =>
  isCompat(s) ? s.compatEmbeddingModel : s.embeddingModel;

/**
 * Where vectors come from, for the identity stored beside them: a Vertex region, or on an
 * OpenAI-compatible provider the base URL itself.
 */
export const embeddingLocationOf = (s: LlmSettings) =>
  isCompat(s) ? (s.baseUrl ?? "") : s.embeddingLocation;

/** Search grounding exists only on Vertex, and only while the switch allows it. */
export const searchGroundingOn = (s: LlmSettings) => s.provider === "vertex" && s.searchGrounding;

/** The Whisper model and language a profile asks for, wherever Whisper runs in it. */
function whisperOf(p: TranscriptionProfile) {
  const model =
    p.live.provider === "whisper"
      ? p.live.model
      : p.redo?.provider === "whisper"
        ? p.redo.model
        : "whisper-large-v3";
  return { model, language: p.live.language };
}

/** Input of `createModels`, from the platform config; Whisper's model and language come from the transcription profile. */
export function modelsConfigOf(
  s: LlmSettings,
  profile: TranscriptionProfile = profileOf(s),
): ModelsConfig {
  const whisper = whisperOf(profile);
  return {
    provider: s.provider,
    ...(isCompat(s) && {
      openaiCompatible: {
        baseUrl: s.baseUrl ?? "",
        apiKey: s.apiKey ?? "",
        transcriptionModel: whisper.model,
        transcriptionLanguage: whisper.language,
        transcriptionKeyTerms: s.transcriptionKeyTerms,
        speechSecondsPerMinute: s.whisperSecondsPerMinute,
        speechConcurrency: s.whisperConcurrency,
        reasoningEffort: s.reasoningEffort,
        maxOutputTokens: s.maxOutputTokens,
      },
    }),
    vertexProject: s.vertexProject,
    vertexLocation: s.vertexLocation,
    groups: groupsOf(s),
    embeddingModel: embeddingModelOf(s),
    embeddingLocation: s.embeddingLocation,
    embeddingDimensions: s.embeddingDimensions,
  };
}

/** Completer settings from the platform config. */
export const completerConfigOf = (s: LlmSettings) => ({
  groups: groupsOf(s),
  provider: s.provider,
  searchGrounding: searchGroundingOn(s),
});

/** Embedder settings from the platform config. */
export const embedderConfigOf = (s: LlmSettings) => ({
  project: s.vertexProject,
  location: s.embeddingLocation,
  model: embeddingModelOf(s),
  provider: s.provider,
  baseUrl: s.baseUrl,
});

/**
 * The providers this deployment has and its default. The environment decides this, never the
 * database: an account can only choose among what is listed here.
 */
export function routingPolicyOf(s: Pick<LlmSettings, "provider" | "providers">): RoutingPolicy {
  const def = providerOfKind(s.provider);
  const named = (s.providers ?? []).map((p) => p.trim()).filter(Boolean);
  const unknown = named.filter((p) => !isProviderId(p));
  if (unknown.length)
    throw new Error(`LLM_PROVIDERS names ${unknown.join(", ")}, which is not a provider`);
  const lacking = JOBS.filter((j) => !serves(def, j));
  if (lacking.length)
    throw new Error(`The default provider ${def} does not serve ${lacking.join(" and ")}`);
  const providers = [...new Set<ProviderId>([def, ...(named as ProviderId[])])];
  return { providers, default: def };
}

/** The settings as one provider sees them: its own kind, its own model lists. */
export const settingsFor = (s: LlmSettings, id: ProviderId): LlmSettings => ({
  ...s,
  provider: PROVIDERS[id].kind,
});

/**
 * What a deployment lacks to call a provider, as one line, or null when it has it all.
 * Scaleway needs its URL and key; Google needs a Vertex project.
 */
export function providerGaps(
  s: Pick<LlmSettings, "baseUrl" | "apiKey" | "vertexProject">,
  id: ProviderId,
): string | null {
  const missing =
    id === "scaleway"
      ? [...(s.baseUrl ? [] : ["LLM_BASE_URL"]), ...(s.apiKey ? [] : ["LLM_API_KEY"])]
      : s.vertexProject
        ? []
        : ["LLM_VERTEX_PROJECT"];
  return missing.length
    ? `provider ${id} needs ${missing.join(" and ")}, which ${missing.length > 1 ? "are" : "is"} not set`
    : null;
}

/**
 * The model ids a provider uses on this deployment for each job, without repeats, so a screen
 * can name them from the config instead of from a copy: transcription is the speech-to-text
 * model, analysis the text models. Only Scaleway's are open models worth naming; Google's
 * lists are empty.
 */
export function providerModelsOf(s: LlmSettings, id: ProviderId): PerJob<string[]> {
  if (id !== "scaleway") return { transcription: [], analysis: [] };
  const profile = profileForProvider(s, id);
  const speech = [profile.live, profile.redo]
    .filter((x) => x?.provider === "whisper")
    .map((x) => x?.model);
  const compat = groupsOf(settingsFor(s, id));
  const once = (list: (string | undefined)[]) => [
    ...new Set(list.filter((m): m is string => Boolean(m))),
  ];
  return {
    transcription: once(speech),
    analysis: once([...compat.text_fast, ...compat.multi_modal_fast, ...compat.multi_modal_pro]),
  };
}
