import type {
  EmbeddingModelV4,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type { SpeechRequestLog } from "./compat";
import { estimateInput, estimateText, reachedProvider } from "./estimate";

/**
 * One call to one deployment, as metering sees it: names and numbers only, never the
 * prompt or the answer. Every attempt is one call, so a retry or a fallback shows up as
 * its own row with `attempt` counting up and `fallback` set once another deployment took
 * over. A refusal is an ok call with `finishReason` naming the reason and no output.
 */
export interface ModelCall {
  readonly group: string;
  /** "vertex" | "openai-compatible" | "fake": who bills the call. */
  readonly provider: string;
  /** The deployment's model id from config, which the vendor's answer does not carry. */
  readonly model: string;
  readonly kind: "generate" | "stream" | "embed" | "speech";
  readonly startedAt: Date;
  readonly ms: number;
  /** Total input, cached and audio included. */
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly audioInputTokens: number | null;
  /** Total output, reasoning included. */
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  /** Speech only. */
  readonly audioSeconds: number | null;
  /** Google Search grounding lookups. */
  readonly searchQueries: number | null;
  readonly usageEstimated: boolean;
  /** The vendor's own reason when it gives one (SAFETY, MAX_TOKENS), else the unified one. */
  readonly finishReason: string | null;
  readonly status: "ok" | "error";
  /** An error class, status code or abort marker; never a message, which may quote the prompt. */
  readonly error: string | null;
  readonly attempt: number;
  readonly fallback: boolean;
}

export type ModelCallObserver = (call: ModelCall) => void;

/** Builds and hands over one ModelCall; the guard runs it where no fault can reach the caller. */
export type Report = (make: () => ModelCall) => void;

let faultReported = false;
/** Faults since the last take, for the test preload; capped, as production never takes them. */
let faultsSeen: unknown[] = [];
const FAULTS_KEPT = 20;

/**
 * The one door every observation goes through: the mapping and the observer run inside it,
 * it never throws, and the first fault per process goes to onFault; later faults, and every
 * fault without a sink, are silent. Metering can be wrong; a model call must not pay for it.
 */
export function observeSafely(
  observe: ModelCallObserver | undefined,
  onFault: ((err: unknown) => void) | undefined,
  make: () => ModelCall,
): void {
  if (!observe) return;
  try {
    observe(make());
  } catch (err) {
    if (faultsSeen.length < FAULTS_KEPT) faultsSeen.push(err);
    if (faultReported) return;
    faultReported = true;
    try {
      onFault?.(err);
    } catch {
      // The fault sink itself failed: there is nowhere left to say so.
    }
  }
}

/** Forgets that a fault was reported, so a test can see the next one. */
export function resetObserverFaults(): void {
  faultReported = false;
}

/** Every fault observeSafely caught since the last take, reported or not; clears the list. */
export function takeObserverFaults(): unknown[] {
  const taken = faultsSeen;
  faultsSeen = [];
  return taken;
}

export interface CallMeta {
  readonly group: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly fallback: boolean;
}

/** Every unit nothing was counted for: a failed call, or the counts an embedding lacks. */
const NO_UNITS = {
  inputTokens: null,
  cachedInputTokens: null,
  audioInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  audioSeconds: null,
  searchQueries: null,
  usageEstimated: false,
} as const;

/** Tokens the vendor counted; undefined becomes null so a missing count never reads as zero. */
function tokens(usage: LanguageModelV4Usage | undefined, metadata?: SharedV4ProviderMetadata) {
  return {
    ...NO_UNITS,
    inputTokens: usage?.inputTokens?.total ?? null,
    cachedInputTokens: usage?.inputTokens?.cacheRead ?? null,
    audioInputTokens: audioTokens(usage),
    outputTokens: usage?.outputTokens?.total ?? null,
    reasoningTokens: usage?.outputTokens?.reasoning ?? null,
    searchQueries: searchQueries(metadata),
  };
}

/** Google's AUDIO prompt tokens; null when the vendor gives no per-modality detail. */
function audioTokens(usage: LanguageModelV4Usage | undefined): number | null {
  const details = (usage?.raw as { promptTokensDetails?: unknown } | undefined)
    ?.promptTokensDetails;
  if (!Array.isArray(details)) return null;
  return details.reduce(
    (sum: number, d: { modality?: unknown; tokenCount?: unknown }) =>
      d?.modality === "AUDIO" && typeof d.tokenCount === "number" ? sum + d.tokenCount : sum,
    0,
  );
}

/** Google Search lookups, under whichever key the Google provider wrote its metadata. */
function searchQueries(metadata: SharedV4ProviderMetadata | undefined): number | null {
  for (const key of ["vertex", "googleVertex", "google"]) {
    const grounding = metadata?.[key]?.groundingMetadata as
      | { webSearchQueries?: unknown }
      | null
      | undefined;
    if (Array.isArray(grounding?.webSearchQueries)) return grounding.webSearchQueries.length;
  }
  return null;
}

function reason(finish: LanguageModelV4FinishReason | undefined): string | null {
  const value = finish?.raw ?? finish?.unified;
  return value ? String(value).toLowerCase() : null;
}

/**
 * What a failed model call may put in a log line: its name and HTTP status, no message, no
 * request, no prompt. The SDK's errors carry the request body, which holds what the host
 * or the participant gave (a transcript, uploaded material), so a log never takes the error.
 */
export function modelErrorShape(err: unknown): { name: string; status: number | null } {
  const e = err as { name?: unknown; statusCode?: unknown; status?: unknown } | null;
  const status =
    typeof e?.statusCode === "number"
      ? e.statusCode
      : typeof e?.status === "number"
        ? e.status
        : null;
  return { name: typeof e?.name === "string" ? e.name : "Error", status };
}

/** What an error is, without its text: a status code, a code, or its class. */
export function errorLabel(err: unknown): string {
  if (!err || typeof err !== "object") return "error";
  const e = err as { statusCode?: number; code?: string; name?: string };
  if (typeof e.statusCode === "number") return `http_${e.statusCode}`;
  if (e.name === "AbortError" || e.name === "TimeoutError") return e.name.toLowerCase();
  if (typeof e.code === "string" && e.code) return e.code.toLowerCase();
  return e.name && e.name !== "Error" ? e.name : "error";
}

function base(meta: CallMeta, kind: ModelCall["kind"], startedAt: Date, t0: number) {
  return {
    group: meta.group,
    provider: meta.provider,
    model: meta.model,
    kind,
    startedAt,
    ms: Math.round(performance.now() - t0),
    attempt: meta.attempt,
    fallback: meta.fallback,
  };
}

export function generateCall(
  meta: CallMeta,
  startedAt: Date,
  t0: number,
  result: LanguageModelV4GenerateResult,
): ModelCall {
  return {
    ...base(meta, "generate", startedAt, t0),
    ...tokens(result.usage, result.providerMetadata),
    finishReason: reason(result.finishReason),
    status: "ok",
    error: null,
  };
}

/** Units the provider never reported: input from the prompt, output from the text so far; reasoning is lost. */
function estimated(meta: CallMeta, prompt: LanguageModelV4Prompt, output: string) {
  return {
    ...NO_UNITS,
    // An openai-compatible chat model reads a transcript; the speech call is metered on its own.
    ...estimateInput(prompt, { audio: meta.provider !== "openai-compatible" }),
    outputTokens: estimateText(output),
    usageEstimated: true,
  };
}

/** A call that threw: free if the provider never accepted it, else input estimated from `prompt`. */
export function failedCall(
  meta: CallMeta,
  kind: ModelCall["kind"],
  startedAt: Date,
  t0: number,
  err: unknown,
  prompt?: LanguageModelV4Prompt,
): ModelCall {
  return {
    ...base(meta, kind, startedAt, t0),
    ...(prompt && reachedProvider(err) ? estimated(meta, prompt, "") : NO_UNITS),
    finishReason: null,
    status: "error",
    error: errorLabel(err),
  };
}

/** One answered speech-to-text request, billed in the audio seconds it carried. */
export function speechCall(e: SpeechRequestLog): ModelCall {
  return {
    group: "speech",
    provider: e.provider,
    model: e.model,
    kind: "speech",
    startedAt: new Date(Date.now() - e.ms),
    ms: e.ms,
    ...NO_UNITS,
    audioSeconds: e.audioSeconds,
    usageEstimated: e.estimated,
    finishReason: null,
    status: "ok",
    error: null,
    attempt: e.attempt,
    fallback: false,
  };
}

export function embedCall(
  meta: CallMeta,
  startedAt: Date,
  t0: number,
  usage: { tokens: number } | undefined,
): ModelCall {
  return {
    ...base(meta, "embed", startedAt, t0),
    ...NO_UNITS,
    inputTokens: usage?.tokens ?? null,
    finishReason: null,
    status: "ok",
    error: null,
  };
}

/**
 * Passes a stream through and reports once it ends: at the finish part's usage, at the
 * first error part, when the reader fails, or when the consumer cancels (an abort). The
 * clock keeps running until the last part, so a stream's time is what the caller waited.
 * Without a finish part's usage (an early end, or none sent) it estimates from `prompt` and the text so far.
 */
export function observedStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  meta: CallMeta,
  startedAt: Date,
  t0: number,
  report: Report,
  prompt: LanguageModelV4Prompt,
): ReadableStream<LanguageModelV4StreamPart> {
  const reader = stream.getReader();
  let usage: LanguageModelV4Usage | undefined;
  let metadata: SharedV4ProviderMetadata | undefined;
  let finish: LanguageModelV4FinishReason | undefined;
  let failure: unknown;
  let streamed = "";
  let reported = false;
  const done = (err?: unknown) => {
    if (reported) return;
    reported = true;
    const error = err ?? failure;
    report(() => ({
      ...base(meta, "stream", startedAt, t0),
      ...(usage ? tokens(usage, metadata) : estimated(meta, prompt, streamed)),
      finishReason: reason(finish),
      status: error === undefined ? "ok" : "error",
      error: error === undefined ? null : errorLabel(error),
    }));
  };
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (err) {
        done(err);
        controller.error(err);
        return;
      }
      if (next.done) {
        done();
        controller.close();
        return;
      }
      const part = next.value;
      if (part.type === "finish") {
        usage = part.usage;
        metadata = part.providerMetadata;
        finish = part.finishReason;
      } else if (part.type === "text-delta") {
        streamed += part.delta;
      } else if (part.type === "error" && failure === undefined) {
        failure = part.error;
      }
      controller.enqueue(part);
    },
    cancel(cause) {
      done(cause ?? new Error("cancelled"));
      return reader.cancel(cause);
    },
  });
}

/** The embedding model with every doEmbed reported, in place of its own usage. */
export function observedEmbedding(
  model: EmbeddingModelV4,
  group: string,
  report: Report,
  provider: string = model.provider,
): EmbeddingModelV4 {
  const meta: CallMeta = { group, provider, model: model.modelId, attempt: 1, fallback: false };
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop !== "doEmbed") return Reflect.get(target, prop, receiver);
      return async (options: Parameters<EmbeddingModelV4["doEmbed"]>[0]) => {
        const startedAt = new Date();
        const t0 = performance.now();
        let result: Awaited<ReturnType<EmbeddingModelV4["doEmbed"]>>;
        try {
          result = await target.doEmbed(options);
        } catch (err) {
          report(() => failedCall(meta, "embed", startedAt, t0, err));
          throw err;
        }
        report(() => embedCall(meta, startedAt, t0, result.usage));
        return result;
      };
    },
  });
}
