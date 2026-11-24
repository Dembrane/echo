/**
 * The AI providers echo can send a call to. A provider is a name, the kind of API behind it
 * and whether using it needs an opt-in. Adding one (a speech provider for a language the
 * others hear badly) is one more entry here, one more `createModels` in the registry and
 * its transcription profile; the routing and the policy do not change.
 */
export type ProviderId = "scaleway" | "google";

export interface ProviderInfo {
  readonly id: ProviderId;
  /** The `LLM_PROVIDER` value that names this provider as the environment's default. */
  readonly kind: "openai-compatible" | "vertex";
  /**
   * A provider that sends data outside the default's processor. A call goes to it only while
   * the project's current setting and, for a conversation's calls, the conversation's own
   * start both say so; going back applies to the very next call.
   */
  readonly optIn: boolean;
}

export const PROVIDERS = {
  scaleway: { id: "scaleway", kind: "openai-compatible", optIn: false },
  google: { id: "google", kind: "vertex", optIn: true },
} as const satisfies Record<ProviderId, ProviderInfo>;

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export const isProviderId = (v: unknown): v is ProviderId =>
  typeof v === "string" && Object.hasOwn(PROVIDERS, v);

/** The provider an `LLM_PROVIDER` value stands for. */
export const providerOfKind = (kind: ProviderInfo["kind"]): ProviderId =>
  kind === "vertex" ? "google" : "scaleway";

/** Which providers this deployment has and which one it uses when nothing says otherwise. */
export interface RoutingPolicy {
  readonly providers: readonly ProviderId[];
  readonly default: ProviderId;
}

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

/**
 * What an account may use and which provider its projects follow by default, from its stored
 * setting and the deployment's policy. An account staff never set offers only the deployment's
 * default. `named` says whether the default is the account's own choice or the deployment's.
 */
export function accountProviders(
  policy: RoutingPolicy,
  stored: { readonly allowed: readonly unknown[] | null; readonly accountDefault: unknown },
): { allowed: ProviderId[]; default: ProviderId | null; named: boolean } {
  const allowed = allowedAmong(policy, stored.allowed ?? [policy.default]);
  if (!allowed.length) return { allowed, default: null, named: false };
  const own = allowedAmong(policy, [stored.accountDefault])[0];
  const named = own !== undefined && allowed.includes(own);
  const fallback = allowed.includes(policy.default) ? policy.default : (allowed[0] as ProviderId);
  return { allowed, default: named ? (own as ProviderId) : fallback, named };
}
