/**
 * The AI providers echo can send a call to. A provider is a name, the kind of API behind it,
 * the jobs it serves and whether using it needs an opt-in. Adding one (a speech provider for a
 * language the others hear badly, serving transcription only) is one more entry here, one more
 * `createModels` in the registry and its transcription profile; the routing and the policy do
 * not change.
 */
export type ProviderId = "scaleway" | "google";

/**
 * The two choices an account makes. Transcription is whoever hears the audio: the live pieces,
 * the improved transcript, its clean-up and the redaction of personal data (whoever hears the
 * audio first also sees its text first). Analysis is everything that reads text: chat, agentic
 * runs, summaries, titles, reports, the map, analysis recipes, verify, canvas, popcorn and
 * present, project setup. Search vectors and Google Search grounding follow analysis.
 */
export type Job = "transcription" | "analysis";

/** The account_event types of the AI provider settings: an account's, and a project's choice for one job. */
export const ORG_PROVIDER_EVENT = "ai_providers.changed";
export const PROJECT_PROVIDER_EVENT = "project.ai_provider.changed";

export const JOBS = ["transcription", "analysis"] as const satisfies readonly Job[];

export const isJob = (v: unknown): v is Job =>
  typeof v === "string" && (JOBS as readonly string[]).includes(v);

/** One value for each job. */
export type PerJob<T> = Readonly<Record<Job, T>>;

export interface ProviderInfo {
  readonly id: ProviderId;
  /** The `LLM_PROVIDER` value that names this provider as the environment's default. */
  readonly kind: "openai-compatible" | "vertex";
  /** The jobs this provider serves; a job can only be set to a provider that serves it. */
  readonly jobs: readonly Job[];
  /** Whether using it is part of the plan, or billed on top of it at cost. */
  readonly billing: "included" | "on_top";
  /**
   * A provider that sends data outside the default's processor. A call goes to it only while
   * the project's current setting and, for a conversation's calls, the conversation's own
   * start both say so; going back applies to the very next call.
   */
  readonly optIn: boolean;
}

export const PROVIDERS = {
  scaleway: {
    id: "scaleway",
    kind: "openai-compatible",
    jobs: JOBS,
    billing: "included",
    optIn: false,
  },
  google: { id: "google", kind: "vertex", jobs: JOBS, billing: "on_top", optIn: true },
} as const satisfies Record<ProviderId, ProviderInfo>;

export const serves = (id: ProviderId, job: Job): boolean => PROVIDERS[id].jobs.includes(job);

/**
 * The providers whose models a provider's own list falls back to when every model of it fails:
 * Google's Gemini list ends on Scaleway's models. Scaleway's never reach Google. A fallback is
 * used for a call only while the account has that provider enabled for the call's job.
 */
export const fallsBackTo = (id: ProviderId): readonly ProviderId[] =>
  PROVIDERS[id].kind === "vertex" ? ["scaleway"] : [];

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export const isProviderId = (v: unknown): v is ProviderId =>
  typeof v === "string" && Object.hasOwn(PROVIDERS, v);

/** The provider an `LLM_PROVIDER` value stands for. */
export const providerOfKind = (kind: ProviderInfo["kind"]): ProviderId =>
  kind === "vertex" ? "google" : "scaleway";

/** Which providers this deployment has and which one it uses when nothing says otherwise. */
export interface RoutingPolicy {
  readonly providers: readonly ProviderId[];
  /** Serves every job: the deployment's own provider, where a call goes when nothing says otherwise. */
  readonly default: ProviderId;
}

/** The providers of a deployment that serve a job. */
export const providersFor = (policy: RoutingPolicy, job: Job): ProviderId[] =>
  policy.providers.filter((id) => serves(id, job));

/** Keeps the providers a list names that the deployment has, in the list's order, without repeats. */
export function allowedAmong(
  policy: RoutingPolicy,
  list: readonly unknown[] | null | undefined,
): ProviderId[] {
  const out: ProviderId[] = [];
  for (const v of list ?? [])
    if (isProviderId(v) && policy.providers.includes(v) && !out.includes(v)) out.push(v);
  return out;
}

/** What an account has stored: the providers it enabled for each job and its default for each job. */
export interface StoredAccountProviders {
  /** org.ai_transcription_providers and org.ai_analysis_providers; null when staff never set them. */
  readonly enabled: Readonly<Record<Job, readonly unknown[] | null>>;
  readonly defaults: Readonly<Record<Job, unknown>>;
}

/**
 * What an account may use for one job and which provider its projects follow by default, from
 * its stored setting and the deployment's policy. Only a provider that is enabled for the job
 * and serves it is ever offered. An account staff never set offers only the deployment's
 * default. `named` says whether the default is the account's own choice or the deployment's.
 */
export function accountProviders(
  policy: RoutingPolicy,
  stored: StoredAccountProviders,
  job: Job,
): { enabled: ProviderId[]; default: ProviderId | null; named: boolean } {
  const enabled = allowedAmong(policy, stored.enabled[job] ?? [policy.default]).filter((id) =>
    serves(id, job),
  );
  if (!enabled.length) return { enabled, default: null, named: false };
  const own = allowedAmong(policy, [stored.defaults[job]])[0];
  const named = own !== undefined && enabled.includes(own);
  const fallback = enabled.includes(policy.default) ? policy.default : (enabled[0] as ProviderId);
  return { enabled, default: named ? (own as ProviderId) : fallback, named };
}
