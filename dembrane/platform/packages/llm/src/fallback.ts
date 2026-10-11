import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { type CallRecord, type CallTrace, takeTrace } from "./trace";

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
  /** Every finished call, answered or failed, with the trace its caller handed in. */
  readonly onCall?: (record: CallRecord) => void;
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

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { trace, call } = untraced(options);
    const started = this.clock();
    try {
      const { value, label } = await this.run((m) => m.doGenerate(call), options.abortSignal);
      this.report(trace, started, { deployment: label, status: "ok", usage: value.usage });
      return value;
    } catch (err) {
      this.report(trace, started, { deployment: null, status: "error" });
      throw err;
    }
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const { trace, call } = untraced(options);
    const started = this.clock();
    let result: { value: LanguageModelV4StreamResult; label: string };
    try {
      result = await this.run((m) => m.doStream(call), options.abortSignal);
    } catch (err) {
      this.report(trace, started, { deployment: null, status: "error", streamed: true });
      throw err;
    }
    if (!this.opts.onCall) return result.value;
    // Usage arrives in the stream's finish part; the call is reported when the stream ends.
    let usage: LanguageModelV4Usage | undefined;
    const label = result.label;
    const watch = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
      transform: (part, controller) => {
        if (part.type === "finish") usage = part.usage;
        controller.enqueue(part);
      },
      flush: () => {
        this.report(trace, started, {
          deployment: label,
          status: usage ? "ok" : "error",
          streamed: true,
          usage,
        });
      },
    });
    return { ...result.value, stream: result.value.stream.pipeThrough(watch) };
  }

  private clock() {
    return (this.opts.now ?? Date.now)();
  }

  private report(
    trace: CallTrace | null,
    started: number,
    r: {
      deployment: string | null;
      status: "ok" | "error";
      streamed?: boolean;
      usage?: LanguageModelV4Usage | undefined;
    },
  ) {
    if (!this.opts.onCall) return;
    try {
      this.opts.onCall({
        group: this.group,
        deployment: r.deployment,
        trace,
        status: r.status,
        streamed: r.streamed ?? false,
        inputTokens: r.usage?.inputTokens.total ?? null,
        outputTokens: r.usage?.outputTokens.total ?? null,
        latencyMs: Math.max(0, this.clock() - started),
      });
    } catch {
      // A broken log never fails the call it describes.
    }
  }

  private async run<T>(
    call: (m: LanguageModelV4) => PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<{ value: T; label: string }> {
    const order = this.healthyFirst();
    let last: unknown;
    for (const [i, d] of order.entries()) {
      for (let attempt = 0; attempt < this.opts.attemptsPerDeployment; attempt++) {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        try {
          return { value: await call(d.model), label: d.label };
        } catch (err) {
          last = err;
          if (!isRetryable(err)) throw err;
          this.recordFailure(d.label);
          if (attempt + 1 < this.opts.attemptsPerDeployment)
            await (this.opts.sleep ?? Bun.sleep)(this.opts.backoffMs * 2 ** attempt);
        }
      }
      this.opts.onFallback?.({ from: d.label, to: order[i + 1]?.label ?? null, error: last });
    }
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

/** The call's trace, and the call without it, so the trace never reaches a provider. */
function untraced(options: LanguageModelV4CallOptions): {
  trace: CallTrace | null;
  call: LanguageModelV4CallOptions;
} {
  const { trace, rest } = takeTrace(options.providerOptions);
  const { providerOptions: _, ...others } = options;
  return { trace, call: rest ? { ...others, providerOptions: rest } : others };
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
