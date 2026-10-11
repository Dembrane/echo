import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

/**
 * What a model call is for: the step of the product that asked, the prompt and its
 * version, and the artefact the answer becomes. Callers hand it in with the call; the
 * FallbackModel reads it back and reports it to `onCall`, which is how every call reaches
 * the generation log without each feature writing to it.
 */
export interface CallTrace {
  readonly step: string;
  readonly promptRef?: string;
  readonly promptVersion?: string;
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
}

/** One finished call as the FallbackModel saw it. */
export interface CallRecord {
  readonly group: string;
  /** The deployment that answered, or null when none did. */
  readonly deployment: string | null;
  readonly trace: CallTrace | null;
  readonly status: "ok" | "error";
  readonly streamed: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
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
