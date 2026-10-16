import type { ModelGroup, ModelsConfig } from "./models";

/** The `llm` section of the platform config, as far as model wiring reads it. */
export interface LlmSettings {
  readonly provider: "vertex" | "openai-compatible";
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly transcriptionModel: string;
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

/** Input of `createModels`, from the platform config. */
export function modelsConfigOf(s: LlmSettings): ModelsConfig {
  return {
    provider: s.provider,
    ...(isCompat(s) && {
      openaiCompatible: {
        baseUrl: s.baseUrl ?? "",
        apiKey: s.apiKey ?? "",
        transcriptionModel: s.transcriptionModel,
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
