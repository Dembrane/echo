import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { type Payer, payer } from "@dembrane/observability";
import type { Completer, Completion, CompletionRequest, Embedder } from "./complete";
import { FallbackModel } from "./fallback";
import type { ModelGroup, Models } from "./models";
import {
  type CallMeta,
  embedCall,
  failedCall,
  generateCall,
  type ModelCall,
  type ModelCallObserver,
  observedEmbedding,
  observeSafely,
} from "./observe";

/** One call a fake answered, with the payer scope it ran under. */
export interface FakeCall {
  readonly kind: "generate" | "stream" | "embed";
  readonly model: string;
  readonly payer: Payer | undefined;
}

let recorded: FakeCall[] = [];

function record(kind: FakeCall["kind"], model: string): void {
  recorded.push({ kind, model, payer: payer() });
}

/** Every fake call since the last take. */
export function fakeCalls(): readonly FakeCall[] {
  return recorded;
}

/** The calls made without a payer scope; clears the list. */
export function takeUnscopedFakeCalls(): FakeCall[] {
  const unscoped = recorded.filter((c) => c.payer === undefined);
  recorded = [];
  return unscoped;
}

/** The payer of the latest fake call since the last take. */
export function lastPayer(): Payer | undefined {
  return recorded.at(-1)?.payer;
}

/** Where a fake reports its calls, as createModels' options do. */
export interface FakeObserving {
  readonly observe?: ModelCallObserver;
  readonly onObserverFault?: (err: unknown) => void;
}

const fakeMeta = (group: string, model: string): CallMeta => ({
  group,
  provider: "fake",
  model,
  attempt: 1,
  fallback: false,
});

export type FakeAnswer =
  | string
  | Partial<Completion>
  | ((
      request: CompletionRequest,
    ) => string | Partial<Completion> | Promise<string | Partial<Completion>>);

/**
 * A completer for tests: each call takes the first rule whose matcher accepts the request
 * (by system prompt, user text or schema) and answers with its recorded output. Every
 * request is kept in `calls`, so a test can assert what was asked and how often.
 */
export class FakeCompleter implements Completer {
  readonly calls: CompletionRequest[] = [];
  private readonly rules: { match: (r: CompletionRequest) => boolean; answer: FakeAnswer }[] = [];

  constructor(
    private readonly identity: (group: ModelGroup) => string = (g) => `fake/${g}`,
    private readonly observing: FakeObserving = {},
  ) {}

  /** Answers requests whose system prompt or user text contains `needle`. */
  on(needle: string | ((r: CompletionRequest) => boolean), answer: FakeAnswer): this {
    const match =
      typeof needle === "function"
        ? needle
        : (r: CompletionRequest) =>
            (r.system ?? "").includes(needle) ||
            (typeof r.user === "string" ? r.user : r.user.join("\n")).includes(needle);
    this.rules.push({ match, answer });
    return this;
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const meta = fakeMeta(request.group, this.identity(request.group));
    const startedAt = new Date();
    const t0 = performance.now();
    const report = (make: () => ModelCall) =>
      observeSafely(this.observing.observe, this.observing.onObserverFault, make);
    record("generate", meta.model);
    this.calls.push(request);
    let completion: Completion;
    try {
      const rule = this.rules.find((r) => r.match(request));
      if (!rule) throw new Error("FakeCompleter has no answer for this request");
      const raw = typeof rule.answer === "function" ? await rule.answer(request) : rule.answer;
      const part = typeof raw === "string" ? { text: raw } : raw;
      completion = {
        text: part.text ?? "",
        finishReason: part.finishReason ?? "STOP",
        usage: part.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        sources: part.sources ?? [],
      };
    } catch (err) {
      report(() => failedCall(meta, "generate", startedAt, t0, err));
      throw err;
    }
    report(() =>
      generateCall(meta, startedAt, t0, {
        content: [],
        finishReason: { unified: "stop", raw: completion.finishReason ?? undefined },
        usage: tokenUsage(completion.usage.prompt_tokens, completion.usage.completion_tokens),
        warnings: [],
      }),
    );
    return completion;
  }

  modelIdentity(group: ModelGroup): string {
    return this.identity(group);
  }
}

/** Deterministic vectors from the text's characters, so equal texts embed equally. */
export class FakeEmbedder implements Embedder {
  readonly model: string;
  readonly endpoint = "fake:local";
  readonly calls: string[] = [];

  constructor(
    readonly dimensions = 8,
    model = "fake/embedding",
    private readonly observing: FakeObserving = {},
  ) {
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const startedAt = new Date();
    const t0 = performance.now();
    record("embed", this.model);
    this.calls.push(text);
    const vector = vectorOf(text, this.dimensions);
    observeSafely(this.observing.observe, this.observing.onObserverFault, () =>
      embedCall(fakeMeta("embedding", this.model), startedAt, t0, { tokens: 1 }),
    );
    return vector;
  }
}

function vectorOf(text: string, dimensions: number): number[] {
  const v: number[] = new Array<number>(dimensions).fill(0);
  for (const [i, ch] of [...text].entries()) {
    const k = i % dimensions;
    v[k] = (v[k] as number) + ((ch.codePointAt(0) ?? 0) % 97) / 97;
  }
  if (!v.some((x) => x !== 0)) v[0] = 1;
  return v.map((x) => Math.round(x * 1e6) / 1e6);
}

/** A text delta, or a whole stream part such as a tool call. */
export type FakeStreamItem = string | LanguageModelV4StreamPart;

export interface FakeModelOptions {
  readonly modelId?: string;
  /** The answer; a function returning null is a refusal (no text, finish reason SAFETY). */
  readonly text?: string | ((prompt: LanguageModelV4Prompt) => string | null);
  /** What doStream sends; the text as one delta when unset. */
  readonly stream?:
    | readonly FakeStreamItem[]
    | ((prompt: LanguageModelV4Prompt) => readonly FakeStreamItem[]);
  readonly usage?: Partial<{ input: number; output: number }>;
  /** Thrown by every call. */
  readonly fail?: unknown;
  /** Wait before answering; Infinity never answers. Either way the abort signal ends it. */
  readonly delayMs?: number;
  /** Receives the options of every call. */
  readonly calls?: LanguageModelV4CallOptions[];
}

/** A language model for tests that answers from a script and records the payer of every call. */
export function fakeLanguageModel(opts: FakeModelOptions = {}): LanguageModelV4 {
  const modelId = opts.modelId ?? "fake";
  const usage = tokenUsage(opts.usage?.input ?? 1, opts.usage?.output ?? 1);
  const answer = (prompt: LanguageModelV4Prompt) =>
    typeof opts.text === "function" ? opts.text(prompt) : (opts.text ?? "ok");
  const start = (kind: "generate" | "stream", o: LanguageModelV4CallOptions) => {
    record(kind, modelId);
    opts.calls?.push(o);
    if (opts.fail !== undefined) throw opts.fail;
  };
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId,
    supportedUrls: {},
    async doGenerate(o): Promise<LanguageModelV4GenerateResult> {
      start("generate", o);
      const text = answer(o.prompt);
      await pause(opts.delayMs, o.abortSignal);
      return {
        content: text === null ? [] : [{ type: "text", text }],
        finishReason: text === null ? REFUSED : STOP,
        usage,
        response: { modelId },
        warnings: [],
      };
    },
    async doStream(o): Promise<LanguageModelV4StreamResult> {
      start("stream", o);
      let items: readonly FakeStreamItem[];
      let refused = false;
      if (typeof opts.stream === "function") items = opts.stream(o.prompt);
      else if (opts.stream) items = opts.stream;
      else {
        const text = answer(o.prompt);
        refused = text === null;
        items = text === null ? [] : [text];
      }
      await pause(opts.delayMs, o.abortSignal);
      const parts = streamParts(items, usage, refused);
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
}

function tokenUsage(input: number | undefined, output: number | undefined): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };
const REFUSED: LanguageModelV4FinishReason = { unified: "content-filter", raw: "SAFETY" };

/** Strings become text deltas inside a text block; parts pass through; the finish part closes. */
function streamParts(
  items: readonly FakeStreamItem[],
  usage: LanguageModelV4Usage,
  refused: boolean,
): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  let open = false;
  for (const item of items) {
    if (typeof item === "string") {
      if (!open) parts.push({ type: "text-start", id: "t" });
      open = true;
      parts.push({ type: "text-delta", id: "t", delta: item });
      continue;
    }
    if (open) parts.push({ type: "text-end", id: "t" });
    open = false;
    parts.push(item);
  }
  if (open) parts.push({ type: "text-end", id: "t" });
  const tools = items.some((i) => typeof i !== "string" && i.type === "tool-call");
  const finishReason: LanguageModelV4FinishReason = refused
    ? REFUSED
    : tools
      ? { unified: "tool-calls", raw: "tool-calls" }
      : STOP;
  parts.push({ type: "finish", finishReason, usage });
  return parts;
}

function pause(ms: number | undefined, signal: AbortSignal | undefined): Promise<void> {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = Number.isFinite(ms) ? setTimeout(resolve, ms) : null;
    signal?.addEventListener(
      "abort",
      () => {
        if (timer) clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** An embedding model for tests: FakeEmbedder's vectors, each call recorded. */
function fakeEmbeddingModel(dimensions: number): EmbeddingModelV4 {
  const modelId = "fake/embedding";
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId,
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    async doEmbed(o) {
      record("embed", modelId);
      return {
        embeddings: o.values.map((v) => vectorOf(v, dimensions)),
        usage: { tokens: o.values.length },
        warnings: [],
      };
    },
  };
}

/**
 * Models whose every group is a fake behind a FallbackModel, as createModels builds them, so
 * `observe` hears each call with provider "fake".
 */
export function fakeModels(
  opts: FakeModelOptions & FakeObserving & { embeddingDimensions?: number } = {},
): Models {
  const { embeddingDimensions = 8, observe, onObserverFault, ...model } = opts;
  const group = (g: ModelGroup) =>
    new FallbackModel(
      g,
      [
        {
          label: `${g}[0]:fake`,
          provider: "fake",
          model: fakeLanguageModel({ ...model, modelId: model.modelId ?? `fake/${g}` }),
        },
      ],
      {
        attemptsPerDeployment: 1,
        backoffMs: 0,
        sleep: async () => {},
        ...(observe && { observe }),
        ...(onObserverFault && { onObserverFault }),
      },
    );
  const built: Record<ModelGroup, FallbackModel> = {
    text_fast: group("text_fast"),
    multi_modal_fast: group("multi_modal_fast"),
    multi_modal_pro: group("multi_modal_pro"),
  };
  const raw = fakeEmbeddingModel(embeddingDimensions);
  const embedding = observe
    ? observedEmbedding(
        raw,
        "embedding",
        (make) => observeSafely(observe, onObserverFault, make),
        "fake",
      )
    : raw;
  return {
    model: (g) => built[g],
    embedding: () => ({ model: embedding, dimensions: embeddingDimensions }),
  };
}
