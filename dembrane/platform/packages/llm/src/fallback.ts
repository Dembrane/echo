import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import {
  type CallMeta,
  failedCall,
  generateCall,
  type ModelCallObserver,
  observedStream,
  observeSafely,
  type Report,
} from "./observe";

export interface Deployment {
  readonly label: string;
  readonly model: LanguageModelV4;
}

export interface FallbackOptions {
  /** Attempts per deployment before moving to the next one. */
  readonly attemptsPerDeployment: number;
  /** Failures within the window that put a deployment on cooldown. */
  readonly allowedFails: number;
  readonly cooldownMs: number;
  readonly backoffMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onFallback?: (event: { from: string; to: string | null; error: unknown }) => void;
  /** Told about every attempt on every deployment: the metering's only source. */
  readonly observe?: ModelCallObserver;
  /** Hears the first fault of the observer or its mapping, once per process. */
  readonly onObserverFault?: (err: unknown) => void;
}

/** Per-call providerOptions: a refused answer moves on to the next deployment. */
export const FALL_BACK_ON_REFUSAL = { fallback: { onRefusal: true } };

/**
 * Per-call providerOptions: each attempt on a deployment is cut after `ms`, except the last
 * attempt of the last deployment, which gets `finalMs` (default `ms`): nothing is left to fall
 * back to, so cutting it can only turn a slow answer into a failure. The cut is a TimeoutError,
 * which is retryable, so it takes the same retry and next-deployment path as any other failure
 * and is metered as one failed call. Every attempt gets a fresh clock.
 */
export function attemptTimeout(ms: number, finalMs: number = ms) {
  return { fallback: { attemptTimeoutMs: ms, finalAttemptTimeoutMs: finalMs } };
}

/** Every deployment declined to answer (a content filter or safety stop). */
export class ModelRefusalError extends Error {
  override name = "ModelRefusalError";
  readonly isRetryable = false;
  constructor(
    readonly group: string,
    readonly finishReason: string | null,
  ) {
    super(`Every ${group} deployment refused to answer (finish_reason=${finishReason})`);
  }
}

class Refused extends Error {
  constructor(readonly finishReason: string | null) {
    super(`refused (finish_reason=${finishReason})`);
  }
}

const DEFAULTS: FallbackOptions = {
  attemptsPerDeployment: 2,
  allowedFails: 3,
  cooldownMs: 60_000,
  backoffMs: 500,
};

/**
 * One model name backed by an ordered list of deployments: numbered deployments take
 * traffic only when the ones before them fail or cool down, as the LiteLLM router did.
 * A stream switches deployment only if it fails before its first part, so a caller never
 * receives, or pays for, two partial answers.
 */
export class FallbackModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "echo-fallback";
  readonly modelId: string;
  private readonly opts: FallbackOptions;
  private readonly failures = new Map<string, number[]>();

  constructor(
    readonly group: string,
    private readonly deployments: readonly Deployment[],
    opts: Partial<FallbackOptions> = {},
  ) {
    if (!deployments.length) throw new Error(`model group ${group} has no deployments`);
    this.modelId = group;
    this.opts = { ...DEFAULTS, ...opts };
  }

  get supportedUrls() {
    return (this.deployments[0] as Deployment).model.supportedUrls;
  }

  /** Metering never changes a call: it runs after the result is in hand and cannot throw. */
  private readonly report: Report = (make) =>
    observeSafely(this.opts.observe, this.opts.onObserverFault, make);

  doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const onRefusal = options.providerOptions?.fallback?.onRefusal === true;
    const bound = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
    const limit = bound(options.providerOptions?.fallback?.attemptTimeoutMs);
    const finalLimit = bound(options.providerOptions?.fallback?.finalAttemptTimeoutMs) ?? limit;
    return this.run(async (d, meta, last) => {
      const attemptMs = last ? finalLimit : limit;
      const startedAt = new Date();
      const t0 = performance.now();
      let result: LanguageModelV4GenerateResult;
      try {
        result = await d.model.doGenerate(
          attemptMs === null
            ? options
            : {
                ...options,
                abortSignal: options.abortSignal
                  ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(attemptMs)])
                  : AbortSignal.timeout(attemptMs),
              },
        );
      } catch (err) {
        this.report(() => failedCall(meta, "generate", startedAt, t0, err));
        throw err;
      }
      this.report(() => generateCall(meta, startedAt, t0, result));
      if (onRefusal && result.finishReason.unified === "content-filter") {
        const raw = result.finishReason.raw ?? result.finishReason.unified;
        throw new Refused(String(raw).toLowerCase());
      }
      return result;
    }, options.abortSignal);
  }

  doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return this.run(async (d, meta) => {
      const startedAt = new Date();
      const t0 = performance.now();
      let result: LanguageModelV4StreamResult;
      try {
        result = await d.model.doStream(options);
      } catch (err) {
        this.report(() => failedCall(meta, "stream", startedAt, t0, err));
        throw err;
      }
      if (!this.opts.observe) return result;
      return { ...result, stream: observedStream(result.stream, meta, startedAt, t0, this.report) };
    }, options.abortSignal);
  }

  private async run<T>(
    call: (d: Deployment, meta: CallMeta, last: boolean) => PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const order = this.healthyFirst();
    let last: unknown;
    let attempts = 0;
    for (const [i, d] of order.entries()) {
      for (let attempt = 0; attempt < this.opts.attemptsPerDeployment; attempt++) {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        attempts++;
        try {
          return await call(
            d,
            {
              group: this.group,
              model: d.model.modelId,
              attempt: attempts,
              fallback: i > 0,
            },
            i === order.length - 1 && attempt === this.opts.attemptsPerDeployment - 1,
          );
        } catch (err) {
          last = err;
          // The same prompt is refused the same way: no retry here, the next deployment gets it.
          if (err instanceof Refused) break;
          if (!isRetryable(err)) throw err;
          this.recordFailure(d.label);
          if (attempt + 1 < this.opts.attemptsPerDeployment)
            await (this.opts.sleep ?? Bun.sleep)(this.opts.backoffMs * 2 ** attempt);
        }
      }
      this.opts.onFallback?.({ from: d.label, to: order[i + 1]?.label ?? null, error: last });
    }
    if (last instanceof Refused) throw new ModelRefusalError(this.group, last.finishReason);
    throw last;
  }

  /** Deployments in configured order, those on cooldown moved last (still tried if all are cooling). */
  private healthyFirst(): Deployment[] {
    const now = (this.opts.now ?? Date.now)();
    const cooling = (d: Deployment) =>
      (this.failures.get(d.label) ?? []).filter((t) => now - t < this.opts.cooldownMs).length >=
      this.opts.allowedFails;
    return [...this.deployments.filter((d) => !cooling(d)), ...this.deployments.filter(cooling)];
  }

  private recordFailure(label: string) {
    const now = (this.opts.now ?? Date.now)();
    const recent = (this.failures.get(label) ?? []).filter((t) => now - t < this.opts.cooldownMs);
    this.failures.set(label, [...recent, now]);
  }
}

/** Rate limits, overload, server errors and network failures are worth another deployment; bad requests are not. */
export function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { isRetryable?: boolean; statusCode?: number; name?: string; code?: string };
  if (typeof e.isRetryable === "boolean") return e.isRetryable;
  if (typeof e.statusCode === "number")
    return e.statusCode === 408 || e.statusCode === 429 || e.statusCode >= 500;
  return (
    e.name === "TimeoutError" ||
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code ?? "")
  );
}
