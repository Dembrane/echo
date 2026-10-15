import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModelV4, LanguageModelV4 } from "@ai-sdk/provider";
import { CompatEmbeddingModel, CompatLanguageModel, echoOptions } from "./compat";
import { type Deployment, FallbackModel, type FallbackOptions } from "./fallback";
import { observedEmbedding, observeSafely } from "./observe";

/** The model groups callers ask for by purpose, never by vendor model name. */
export type ModelGroup = "text_fast" | "multi_modal_fast" | "multi_modal_pro";

/** An OpenAI-compatible provider (Scaleway Generative APIs): chat, embeddings and speech-to-text. */
export interface OpenAICompatibleConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly transcriptionModel: string;
  readonly reasoningEffort?: string | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export interface ModelsConfig {
  /** Which provider serves the calls. Defaults to vertex. */
  readonly provider?: "vertex" | "openai-compatible";
  /** Required when provider is openai-compatible. */
  readonly openaiCompatible?: OpenAICompatibleConfig;
  readonly vertexProject: string;
  /** "eu" keeps processing inside the EU on Vertex's EU residency endpoint. */
  readonly vertexLocation: string;
  readonly groups: Readonly<Record<ModelGroup, readonly string[]>>;
  readonly embeddingModel: string;
  /** Embedding models are regional on Vertex (prod: europe-west4); the eu multi-region does not serve them. */
  readonly embeddingLocation: string;
  readonly embeddingDimensions: number;
}

export interface Models {
  model(group: ModelGroup): LanguageModelV4;
  embedding(): { model: EmbeddingModelV4; dimensions: number };
  /** Per-call provider options naming the spoken language; only an OpenAI-compatible provider has any. */
  speechHint?(language: string | null | undefined): Record<string, Record<string, unknown>>;
}

/** The provider options that carry the spoken language, or none when the provider does not use them. */
export const speechHint = (models: Models, language: string | null | undefined) =>
  models.speechHint?.(language) ?? {};

/**
 * Builds the groups from config. text_fast falls back to multi_modal_pro after its own
 * deployments, as the Python router did for text-only work. `opts.observe` hears every
 * attempt of every group and the embedding model: the one place all model calls pass.
 */
export function createModels(cfg: ModelsConfig, opts: Partial<FallbackOptions> = {}): Models {
  const compat = cfg.provider === "openai-compatible" ? requireCompat(cfg) : null;
  const vertex = compat
    ? null
    : createVertex({ project: cfg.vertexProject, location: cfg.vertexLocation });
  const chat = compat
    ? createOpenAICompatible({
        name: "openai-compatible",
        baseURL: compat.baseUrl,
        apiKey: compat.apiKey,
        supportsStructuredOutputs: true,
        includeUsage: true,
        ...(compat.fetch && { fetch: compat.fetch }),
      })
    : null;
  const build = (id: string): LanguageModelV4 =>
    chat && compat
      ? new CompatLanguageModel(chat.languageModel(id) as LanguageModelV4, compat)
      : ((vertex as NonNullable<typeof vertex>)(id) as LanguageModelV4);
  const deployments = (group: ModelGroup): Deployment[] =>
    cfg.groups[group].map((id, i) => ({
      label: `${group}[${i}]:${id}`,
      model: build(id),
    }));
  const built: Record<ModelGroup, FallbackModel> = {
    text_fast: new FallbackModel(
      "text_fast",
      [...deployments("text_fast"), ...deployments("multi_modal_pro")],
      opts,
    ),
    multi_modal_fast: new FallbackModel("multi_modal_fast", deployments("multi_modal_fast"), opts),
    multi_modal_pro: new FallbackModel("multi_modal_pro", deployments("multi_modal_pro"), opts),
  };
  const raw =
    chat && compat
      ? new CompatEmbeddingModel(
          chat.embeddingModel(cfg.embeddingModel) as EmbeddingModelV4,
          cfg.embeddingDimensions,
        )
      : (createVertex({
          project: cfg.vertexProject,
          location: cfg.embeddingLocation,
        }).textEmbeddingModel(cfg.embeddingModel) as EmbeddingModelV4);
  const embedding = opts.observe
    ? observedEmbedding(raw, "embedding", (make) =>
        observeSafely(opts.observe, opts.onObserverFault, make),
      )
    : raw;
  return {
    model: (g) => built[g],
    embedding: () => ({ model: embedding, dimensions: cfg.embeddingDimensions }),
    ...(compat && { speechHint: echoOptions }),
  };
}

function requireCompat(cfg: ModelsConfig): OpenAICompatibleConfig {
  if (!cfg.openaiCompatible?.baseUrl || !cfg.openaiCompatible.apiKey)
    throw new Error("LLM_PROVIDER=openai-compatible needs LLM_BASE_URL and LLM_API_KEY");
  return cfg.openaiCompatible;
}
