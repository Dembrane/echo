import type {
  EmbeddingModelV4,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { CallTrace } from "./trace";

/**
 * One call to one deployment, as metering sees it: names and numbers only, never the
 * prompt or the answer. Every attempt is one call, so a retry or a fallback shows up as
 * its own row with `attempt` counting up and `fallback` set once another deployment took
 * over. A refusal is an ok call with `finishReason` naming the reason and no output.
 */
export interface ModelCall {
  readonly group: string;
  /** The deployment's model id from config, which the vendor's answer does not carry. */
  readonly model: string;
  readonly kind: "generate" | "stream" | "embed";
  readonly startedAt: Date;
  readonly ms: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** The vendor's own reason when it gives one (SAFETY, MAX_TOKENS), else the unified one. */
  readonly finishReason: string | null;
  readonly status: "ok" | "error";
  /** An error class, status code or abort marker; never a message, which may quote the prompt. */
  readonly error: string | null;
  readonly attempt: number;
  readonly fallback: boolean;
  /** What the call was for, when the caller said so. */
  readonly trace?: CallTrace;
}

export type ModelCallObserver = (call: ModelCall) => void;

/** Builds and hands over one ModelCall; the guard runs it where no fault can reach the caller. */
export type Report = (make: () => ModelCall) => void;

let faultReported = false;

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

export interface CallMeta {
  readonly group: string;
  readonly model: string;
  readonly attempt: number;
  readonly fallback: boolean;
  readonly trace?: CallTrace | undefined;
}

/** Tokens the vendor counted; undefined becomes null so a missing count never reads as zero. */
function tokens(usage: LanguageModelV4Usage | undefined) {
  return {
    inputTokens: usage?.inputTokens?.total ?? null,
    outputTokens: usage?.outputTokens?.total ?? null,
  };
}

function reason(finish: LanguageModelV4FinishReason | undefined): string | null {
  const value = finish?.raw ?? finish?.unified;
  return value ? String(value).toLowerCase() : null;
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
    model: meta.model,
    kind,
    startedAt,
    ms: Math.round(performance.now() - t0),
    attempt: meta.attempt,
    fallback: meta.fallback,
    ...(meta.trace && { trace: meta.trace }),
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
    ...tokens(result.usage),
    finishReason: reason(result.finishReason),
    status: "ok",
    error: null,
  };
}

export function failedCall(
  meta: CallMeta,
  kind: ModelCall["kind"],
  startedAt: Date,
  t0: number,
  err: unknown,
): ModelCall {
  return {
    ...base(meta, kind, startedAt, t0),
    inputTokens: null,
    outputTokens: null,
    finishReason: null,
    status: "error",
    error: errorLabel(err),
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
    inputTokens: usage?.tokens ?? null,
    outputTokens: null,
    finishReason: null,
    status: "ok",
    error: null,
  };
}

/**
 * Passes a stream through and reports once it ends: at the finish part's usage, at the
 * first error part, when the reader fails, or when the consumer cancels (an abort). The
 * clock keeps running until the last part, so a stream's time is what the caller waited.
 */
export function observedStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  meta: CallMeta,
  startedAt: Date,
  t0: number,
  report: Report,
): ReadableStream<LanguageModelV4StreamPart> {
  const reader = stream.getReader();
  let usage: LanguageModelV4Usage | undefined;
  let finish: LanguageModelV4FinishReason | undefined;
  let failure: unknown;
  let reported = false;
  const done = (err?: unknown) => {
    if (reported) return;
    reported = true;
    const error = err ?? failure;
    report(() =>
      error !== undefined
        ? failedCall(meta, "stream", startedAt, t0, error)
        : {
            ...base(meta, "stream", startedAt, t0),
            ...tokens(usage),
            finishReason: reason(finish),
            status: "ok",
            error: null,
          },
    );
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
        finish = part.finishReason;
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
): EmbeddingModelV4 {
  const meta: CallMeta = { group, model: model.modelId, attempt: 1, fallback: false };
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
