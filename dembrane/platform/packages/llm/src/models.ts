import { createVertex } from "@ai-sdk/google-vertex";
import type { EmbeddingModelV4, LanguageModelV4 } from "@ai-sdk/provider";
import { type Deployment, FallbackModel, type FallbackOptions } from "./fallback";

/** The model groups callers ask for by purpose, never by vendor model name. */
export type ModelGroup = "text_fast" | "multi_modal_fast" | "multi_modal_pro";

export interface ModelsConfig {
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
}

/**
 * Builds the groups from config. text_fast falls back to multi_modal_pro after its own
 * deployments, as the Python router did for text-only work.
 */
export function createModels(cfg: ModelsConfig, opts: Partial<FallbackOptions> = {}): Models {
  const vertex = createVertex({ project: cfg.vertexProject, location: cfg.vertexLocation });
  const deployments = (group: ModelGroup): Deployment[] =>
    cfg.groups[group].map((id, i) => ({
      label: `${group}[${i}]:${id}`,
      model: vertex(id) as LanguageModelV4,
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
  const regional = createVertex({ project: cfg.vertexProject, location: cfg.embeddingLocation });
  const embedding = regional.textEmbeddingModel(cfg.embeddingModel) as EmbeddingModelV4;
  return {
    model: (g) => built[g],
    embedding: () => ({ model: embedding, dimensions: cfg.embeddingDimensions }),
  };
}
