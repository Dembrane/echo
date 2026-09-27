import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import type { ModelGroup, Models } from "./models";

/**
 * One chat completion the way the Python features asked LiteLLM for it: a system prompt, a
 * user message, and the few knobs they set. Features depend on this interface, never on a
 * vendor SDK, so tests hand in a fake that replays recorded answers.
 */
export interface CompletionRequest {
  readonly group: ModelGroup;
  readonly system?: string;
  /** The user turn; several strings are several user messages in order. */
  readonly user: string | readonly string[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Ask for a JSON answer shaped by this JSON schema (Vertex responseSchema). */
  readonly jsonSchema?: Record<string, unknown>;
  /** Gemini thinking budget; 0 turns thinking off for latency-bound calls. */
  readonly thinkingBudget?: number;
  /** Ground the answer with Google Search; its citations come back as `sources`. */
  readonly googleSearch?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface Completion {
  readonly text: string;
  readonly finishReason: string | null;
  /** Token counts under the names the Python code recorded (prompt, completion, total). */
  readonly usage: Readonly<Record<string, number>>;
  /** Search citations of a grounded answer, deduplicated by URL, in answer order. */
  readonly sources: readonly { readonly url: string; readonly title: string }[];
}

export interface Completer {
  complete(request: CompletionRequest): Promise<Completion>;
  /** What a group resolves to, as the Python settings named it ("vertex_ai/<model>"). */
  modelIdentity(group: ModelGroup): string;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
  /** The deployment identity that keys stored vectors (model, endpoint, dimensions). */
  readonly model: string;
  readonly endpoint: string;
  readonly dimensions: number;
}

const MAX_SOURCES = 5;

function prompt(request: CompletionRequest): LanguageModelV4Prompt {
  const users = typeof request.user === "string" ? [request.user] : [...request.user];
  return [
    ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
    ...users.map((text) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })),
  ];
}

interface GroundingChunk {
  readonly web?: { readonly uri?: string; readonly title?: string };
}

function groundingSources(metadata: unknown): { url: string; title: string }[] {
  const m = (metadata ?? {}) as Record<string, { groundingMetadata?: unknown } | undefined>;
  const grounding = (m.vertex?.groundingMetadata ?? m.google?.groundingMetadata ?? null) as {
    groundingChunks?: GroundingChunk[];
  } | null;
  const out: { url: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const chunk of grounding?.groundingChunks ?? []) {
    const url = String(chunk.web?.uri ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: String(chunk.web?.title || url).trim() });
    if (out.length === MAX_SOURCES) break;
  }
  return out;
}

/** Calls a model group directly (no SDK-side retries; the group's fallback retries). */
export async function completeWith(
  model: LanguageModelV4,
  request: CompletionRequest,
): Promise<Completion> {
  const signals = [
    ...(request.signal ? [request.signal] : []),
    ...(request.timeoutMs ? [AbortSignal.timeout(request.timeoutMs)] : []),
  ];
  const options: LanguageModelV4CallOptions = {
    prompt: prompt(request),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.maxTokens !== undefined && { maxOutputTokens: request.maxTokens }),
    ...(request.jsonSchema && {
      responseFormat: { type: "json" as const, schema: request.jsonSchema as never },
    }),
    ...(request.googleSearch && {
      tools: [
        {
          type: "provider" as const,
          id: "google.google_search" as const,
          name: "google_search",
          args: {},
        },
      ],
    }),
    ...(request.thinkingBudget !== undefined && {
      providerOptions: {
        vertex: { thinkingConfig: { thinkingBudget: request.thinkingBudget } },
      },
    }),
    ...(signals.length && { abortSignal: AbortSignal.any(signals) }),
  };
  const result = await model.doGenerate(options);
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
  const input = result.usage.inputTokens.total;
  const output = result.usage.outputTokens.total;
  const usage: Record<string, number> = {};
  if (typeof input === "number") usage.prompt_tokens = input;
  if (typeof output === "number") usage.completion_tokens = output;
  if (typeof input === "number" && typeof output === "number") usage.total_tokens = input + output;
  return {
    text,
    finishReason: result.finishReason?.raw ?? result.finishReason?.unified ?? null,
    usage,
    sources: groundingSources(result.providerMetadata),
  };
}

export interface VertexCompleterConfig {
  readonly groups: Readonly<Record<ModelGroup, readonly string[]>>;
}

/** The production completer over the configured model groups. */
export function vertexCompleter(models: Models, cfg: VertexCompleterConfig): Completer {
  return {
    complete: (request) => completeWith(models.model(request.group), request),
    modelIdentity: (group) => vertexName(cfg.groups[group][0] ?? group),
  };
}

export interface VertexEmbedderConfig {
  readonly project: string;
  readonly location: string;
  readonly model: string;
}

/**
 * Vertex embeddings; the identity strings match what the Python deployment recorded. The
 * model client is resolved on first use, so composing an app never touches it.
 */
export function vertexEmbedder(models: Models, cfg: VertexEmbedderConfig): Embedder {
  return {
    model: vertexName(cfg.model),
    endpoint: `vertex:${cfg.project}:${cfg.location}`,
    get dimensions() {
      return models.embedding().dimensions;
    },
    async embed(text) {
      const { model } = models.embedding();
      const result = await (model as EmbeddingModelV4).doEmbed({
        values: [text.replaceAll("\n", " ").trim()],
      });
      const vector = result.embeddings[0];
      if (!vector) throw new Error("the embedding call returned no vector");
      return [...vector];
    },
  };
}

/** A model name as the Python settings wrote it: "vertex_ai/<model>", whether or not config already carries the prefix. */
export const vertexName = (model: string) => `vertex_ai/${model.replace(/^vertex_ai\//, "")}`;
