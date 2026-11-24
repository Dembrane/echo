import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import { routing } from "@dembrane/observability";
import {
  CompatEmbeddingModel,
  CompatLanguageModel,
  echoOptions,
  languageHint,
  type SpeechRequestLog,
  type SpeechResult,
  transcribeAudio,
  transcribeSegments,
} from "./compat";
import { type Deployment, FallbackModel, type FallbackOptions } from "./fallback";
import { observedEmbedding, observeSafely, speechCall } from "./observe";
import { type SpeechGate, type SpeechPriority, speechGateFor } from "./speech-gate";

/** The model groups callers ask for by purpose, never by vendor model name. */
export type ModelGroup = "text_fast" | "multi_modal_fast" | "multi_modal_pro";

/** An OpenAI-compatible provider (Scaleway Generative APIs): chat, embeddings and speech-to-text. */
export interface OpenAICompatibleConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly transcriptionModel: string;
  readonly reasoningEffort?: string | undefined;
  readonly maxOutputTokens?: number | undefined;
  /** "auto" lets Whisper hear the language of each piece; "project" forces the project's language. */
  readonly transcriptionLanguage?: "auto" | "project" | undefined;
  /** Send the project's key terms as Whisper's prompt. Off by default: see LLM_WHISPER_KEY_TERMS. */
  readonly transcriptionKeyTerms?: boolean | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** Audio seconds per minute the provider takes for this process; unset or 0 sends without pacing. */
  readonly speechSecondsPerMinute?: number | undefined;
  /** Requests in flight at once; unset keeps the gate's default. */
  readonly speechConcurrency?: number | undefined;
  readonly speechGate?: SpeechGate | undefined;
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
  /** Replaces how Vertex requests are sent and signed; tests hand in a stub and no credentials. */
  readonly vertexClient?: {
    readonly fetch?: typeof fetch;
    readonly headers?: Record<string, string>;
  };
  /**
   * Vertex only: models a call falls back to after its Gemini list, on the OpenAI-compatible
   * provider. The other direction does not exist: a call on the compatible provider never
   * falls back to Vertex, because its list holds none.
   */
  readonly fallbackTo?: {
    readonly openaiCompatible: OpenAICompatibleConfig;
    readonly groups: Readonly<Record<ModelGroup, readonly string[]>>;
  };
}

export interface Models {
  model(group: ModelGroup): LanguageModelV4;
  embedding(): { model: EmbeddingModelV4; dimensions: number };
  /** Per-call provider options naming the spoken language; only an OpenAI-compatible provider has any. */
  speechHint?(language: string | null | undefined): Record<string, Record<string, unknown>>;
  /**
   * Audio to text on a dedicated speech-to-text model, when the provider has one (the
   * OpenAI-compatible provider). Its text is the transcript as heard, word for word.
   */
  speechToText?: {
    readonly model: string;
    transcribe(
      audio: Uint8Array,
      opts?: {
        language?: string | null;
        prompt?: string;
        signal?: AbortSignal;
        priority?: SpeechPriority;
        seconds?: number;
      },
    ): Promise<string>;
    /** The same, as sentences with their start and end in seconds. */
    transcribeSegments(
      audio: Uint8Array,
      opts?: {
        language?: string | null;
        prompt?: string;
        signal?: AbortSignal;
        /** Sampling temperature: 0 is Whisper's default; a retry of a doubtful span raises it. */
        temperature?: number;
        /** Send this language even where the configuration leaves the language to Whisper: a retry names the language it heard. */
        forceLanguage?: string;
        priority?: SpeechPriority;
        /** Seconds of audio in this call, for the pacing; estimated from the size when absent. */
        seconds?: number;
      },
    ): Promise<SpeechResult>;
  };
}

/** The provider options that carry the spoken language, or none when the provider does not use them. */
export const speechHint = (models: Models, language: string | null | undefined) =>
  models.speechHint?.(language) ?? {};

/**
 * Builds the groups from config. text_fast falls back to multi_modal_pro after its own
 * deployments, as the Python router did for text-only work. `opts.observe` hears every
 * attempt of every group and the embedding model: the one place all model calls pass.
 */
export function createModels(
  cfg: ModelsConfig,
  opts: Partial<FallbackOptions> & {
    /** Hears every request to the speech-to-text endpoint, for one structured log line each. */
    onSpeechRequest?: (e: SpeechRequestLog) => void;
  } = {},
): Models {
  const configured = cfg.provider === "openai-compatible" ? requireCompat(cfg) : null;
  const compat = configured && compatEndpoint(configured, opts);
  const chat = compat && chatClient(compat);
  const vertex = compat
    ? null
    : createVertex({
        project: cfg.vertexProject,
        location: cfg.vertexLocation,
        ...cfg.vertexClient,
      });
  // The same models, behind a Vertex call: after its Gemini list a call falls to these.
  const tailCompat =
    !compat && cfg.fallbackTo ? compatEndpoint(cfg.fallbackTo.openaiCompatible, opts) : null;
  const tailChat = tailCompat && chatClient(tailCompat);
  const build = (id: string): LanguageModelV4 =>
    chat && compat
      ? new CompatLanguageModel(chat.languageModel(id) as LanguageModelV4, compat)
      : new LabelledVertexModel((vertex as NonNullable<typeof vertex>)(id) as LanguageModelV4);
  const provider = compat ? "openai-compatible" : "vertex";
  const deployments = (group: ModelGroup): Deployment[] => [
    ...cfg.groups[group].map((id, i) => ({
      label: `${group}[${i}]:${id}`,
      provider,
      model: build(id),
    })),
    ...(tailChat && tailCompat && cfg.fallbackTo
      ? cfg.fallbackTo.groups[group].map((id, i) => ({
          label: `${group}[scaleway ${i}]:${id}`,
          provider: "openai-compatible",
          model: new CompatLanguageModel(tailChat.languageModel(id) as LanguageModelV4, tailCompat),
        }))
      : []),
  ];
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
          ...cfg.vertexClient,
        }).textEmbeddingModel(cfg.embeddingModel) as EmbeddingModelV4);
  const embedding = opts.observe
    ? observedEmbedding(
        raw,
        "embedding",
        (make) => observeSafely(opts.observe, opts.onObserverFault, make),
        provider,
      )
    : raw;
  return {
    model: (g) => built[g],
    embedding: () => ({ model: embedding, dimensions: cfg.embeddingDimensions }),
    ...(compat && {
      speechHint: echoOptions,
      speechToText: {
        model: compat.transcriptionModel,
        transcribe: (audio, o = {}) =>
          transcribeAudio(
            compat,
            audio,
            whisperLanguage(compat, o.language),
            o.signal,
            whisperPrompt(compat, o.prompt),
            { priority: o.priority, seconds: o.seconds },
          ),
        transcribeSegments: (audio, o = {}) =>
          transcribeSegments(
            compat,
            audio,
            o.forceLanguage ?? whisperLanguage(compat, o.language),
            o.signal,
            whisperPrompt(compat, o.prompt),
            o.temperature,
            { priority: o.priority, seconds: o.seconds },
          ),
      },
    }),
  };
}

/**
 * The compatible provider's endpoint as the models use it. One gate per endpoint and process:
 * the worker builds several Models on the same Whisper endpoint and they share one limit.
 */
function compatEndpoint(
  c: OpenAICompatibleConfig,
  opts: Partial<FallbackOptions> & { onSpeechRequest?: (e: SpeechRequestLog) => void },
) {
  return {
    ...c,
    speechGate: speechGateFor(c.baseUrl, {
      secondsPerMinute: c.speechSecondsPerMinute ?? 0,
      ...(c.speechConcurrency && { concurrency: c.speechConcurrency }),
    }),
    onSpeechRequest: opts.onSpeechRequest,
    // Only an answered request is billed; a 429 or a fault costs nothing.
    onSpeechAnswered: (e: SpeechRequestLog) =>
      observeSafely(opts.observe, opts.onObserverFault, () => speechCall(e)),
  };
}

const chatClient = (c: OpenAICompatibleConfig) =>
  createOpenAICompatible({
    name: "openai-compatible",
    baseURL: c.baseUrl,
    apiKey: c.apiKey,
    supportsStructuredOutputs: true,
    includeUsage: true,
    ...(c.fetch && { fetch: c.fetch }),
  });

/** Vertex label values are lowercase letters, digits, hyphens and underscores, up to 63. */
const LABEL_VALUE = /^[a-z0-9_-]{1,63}$/;

/**
 * A Vertex model whose requests carry the organisation the routing policy named, as a label,
 * so Google's own billing export lists which organisations Google served. The label is read
 * where the request is made, from the routing scope the call runs in.
 */
export class LabelledVertexModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";

  constructor(private readonly inner: LanguageModelV4) {}

  get provider() {
    return this.inner.provider;
  }
  get modelId() {
    return this.inner.modelId;
  }
  get supportedUrls() {
    return this.inner.supportedUrls;
  }

  private labelled(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
    const org = routing()?.organisationId?.toLowerCase();
    if (!org || !LABEL_VALUE.test(org)) return options;
    const vertex = (options.providerOptions?.vertex ?? {}) as Record<string, unknown>;
    return {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        vertex: {
          ...vertex,
          labels: {
            ...(vertex.labels as Record<string, string> | undefined),
            organisation_id: org,
          },
        },
      },
    };
  }

  doGenerate(options: LanguageModelV4CallOptions) {
    return this.inner.doGenerate(this.labelled(options));
  }
  doStream(options: LanguageModelV4CallOptions) {
    return this.inner.doStream(this.labelled(options));
  }
}

/** The language sent to Whisper: none lets it listen, which is how a piece that switches language is kept. */
const whisperLanguage = (c: OpenAICompatibleConfig, language: string | null | undefined) =>
  c.transcriptionLanguage === "auto" ? undefined : languageHint(language);
/** The key terms go to Whisper only when asked: as its prompt they made it return less text (measured). */
const whisperPrompt = (c: OpenAICompatibleConfig, prompt: string | undefined) =>
  c.transcriptionKeyTerms ? prompt : undefined;

function requireCompat(cfg: ModelsConfig): OpenAICompatibleConfig {
  if (!cfg.openaiCompatible?.baseUrl || !cfg.openaiCompatible.apiKey)
    throw new Error("LLM_PROVIDER=openai-compatible needs LLM_BASE_URL and LLM_API_KEY");
  return cfg.openaiCompatible;
}
