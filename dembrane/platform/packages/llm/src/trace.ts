import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

/**
 * What a model call is for: the step of the product that asked, the prompt and its
 * version, and the artefact the answer becomes. Callers hand it in with the call; the
 * FallbackModel takes it off before the provider sees it and puts it on the ModelCall, so
 * metering stores it in model_call without each feature writing there.
 */
export interface CallTrace {
  readonly step: string;
  readonly promptRef?: string;
  readonly promptVersion?: string;
  readonly targetType?: string;
  readonly targetId?: string;
}

/** The providerOptions key the trace travels under. Vertex reads only its own keys. */
export const TRACE_KEY = "dembrane";

/** Provider options carrying a trace, merged over the caller's own. */
export function withTrace(
  trace: CallTrace | undefined,
  base: SharedV4ProviderOptions = {},
): SharedV4ProviderOptions {
  if (!trace) return base;
  const clean = Object.fromEntries(Object.entries(trace).filter(([, v]) => v !== undefined));
  return { ...base, [TRACE_KEY]: clean as Record<string, string> };
}

/** The trace in a call's provider options, and the options without it. */
export function takeTrace(options: SharedV4ProviderOptions | undefined): {
  trace: CallTrace | null;
  rest: SharedV4ProviderOptions | undefined;
} {
  if (!options || !(TRACE_KEY in options)) return { trace: null, rest: options };
  const { [TRACE_KEY]: raw, ...rest } = options;
  const t = (raw ?? {}) as Record<string, unknown>;
  const trace = typeof t.step === "string" ? (t as unknown as CallTrace) : null;
  return { trace, rest: Object.keys(rest).length ? rest : undefined };
}
