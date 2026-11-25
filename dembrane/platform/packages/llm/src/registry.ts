import { type Completer, type Embedder, vertexCompleter, vertexEmbedder } from "./complete";
import type { FallbackOptions } from "./fallback";
import { createModels, type Models, type ModelsConfig } from "./models";
import { ownSpeech, profileGaps, speechProvidersOf, type TranscriptionProfile } from "./profiles";
import { PROVIDERS, type ProviderId, type RoutingPolicy } from "./providers";
import { type ProviderResolver, routingCompleter, routingEmbedder, routingModels } from "./routing";
import {
  completerConfigOf,
  embedderConfigOf,
  groupsOf,
  type LlmSettings,
  modelsConfigOf,
  providerGaps,
  settingsFor,
} from "./settings";

function withTransport(cfg: ModelsConfig, hooks: ModelHooks): ModelsConfig {
  const t = hooks.transport;
  if (!t) return cfg;
  return {
    ...cfg,
    ...(t.vertex && { vertexClient: t.vertex }),
    ...(t.compatFetch &&
      cfg.openaiCompatible && {
        openaiCompatible: { ...cfg.openaiCompatible, fetch: t.compatFetch },
      }),
  };
}

/** What one provider offers the features: language models, a completer and an embedder. */
export interface ProviderKit {
  readonly models: Models;
  readonly completer: Completer;
  readonly embedder: Embedder;
}

export type Registry = Readonly<Partial<Record<ProviderId, ProviderKit>>>;

export type ModelHooks = Partial<FallbackOptions> & {
  onSpeechRequest?: (e: object) => void;
  /** Replaces the transport of each provider; tests. */
  transport?: {
    readonly vertex?: ModelsConfig["vertexClient"];
    readonly compatFetch?: typeof fetch;
  };
};

/**
 * One kit per provider the deployment has. Google's models fall back to Scaleway's after
 * their own list when the deployment has Scaleway; Scaleway's never reach Google.
 */
export function createRegistry(
  s: LlmSettings,
  policy: RoutingPolicy,
  profileOf: (id: ProviderId) => TranscriptionProfile,
  hooks: ModelHooks = {},
): Registry {
  const out: Partial<Record<ProviderId, ProviderKit>> = {};
  for (const id of policy.providers) {
    const ps = settingsFor(s, id);
    const cfg: ModelsConfig = withTransport(modelsConfigOf(ps, profileOf(id)), hooks);
    const scaleway = policy.providers.includes("scaleway") && id !== "scaleway";
    const sw = scaleway ? settingsFor(s, "scaleway") : null;
    const models = createModels(
      sw
        ? {
            ...cfg,
            fallbackTo: {
              openaiCompatible: withTransport(modelsConfigOf(sw, profileOf("scaleway")), hooks)
                .openaiCompatible as NonNullable<ModelsConfig["openaiCompatible"]>,
              groups: groupsOf(sw),
            },
          }
        : cfg,
      hooks,
    );
    out[id] = {
      models,
      completer: vertexCompleter(models, completerConfigOf(ps)),
      embedder: vertexEmbedder(models, embedderConfigOf(ps)),
    };
  }
  return out;
}

/** The models, completer and embedder every feature receives: each call goes where its payer resolves. */
export function routedKit(
  registry: Registry,
  policy: RoutingPolicy,
  resolver: ProviderResolver,
): ProviderKit {
  const pick = <K extends keyof ProviderKit>(k: K) =>
    Object.fromEntries(
      policy.providers.flatMap((id) => (registry[id] ? [[id, registry[id][k]]] : [])),
    ) as Partial<Record<ProviderId, ProviderKit[K]>>;
  return {
    models: routingModels(pick("models") as Partial<Record<ProviderId, Models>>, policy, resolver),
    completer: routingCompleter(
      pick("completer") as Partial<Record<ProviderId, Completer>>,
      policy,
      resolver,
    ),
    embedder: routingEmbedder(
      pick("embedder") as Partial<Record<ProviderId, Embedder>>,
      policy,
      resolver,
    ),
  };
}

/**
 * Models on one speech provider whatever serves chat: the profile's Gemini model leads that
 * provider's audio group (its fallbacks follow), and on the compatible provider the profile's
 * clean-up model is the text model.
 */
export function speechModels(
  s: LlmSettings,
  profile: TranscriptionProfile,
  speech: "whisper" | "gemini",
  hooks: ModelHooks = {},
  geminiModel?: string,
): Models {
  const tuned: LlmSettings = {
    ...s,
    provider: speech === "whisper" ? "openai-compatible" : "vertex",
    ...(geminiModel && {
      multiModalPro: [geminiModel, ...s.multiModalPro.filter((m) => m !== geminiModel)],
    }),
    ...(profile.cleanUp && { compatTextFast: [profile.cleanUp.model] }),
  };
  return createModels(withTransport(modelsConfigOf(tuned, profile), hooks), hooks);
}

/**
 * What the deployment lacks for the providers it lists and the profile each runs: one line
 * per gap, empty when it can boot. A provider without its credentials is a boot failure, never
 * a call that fails later on an account that was allowed it.
 */
export function bootGaps(
  s: LlmSettings,
  policy: RoutingPolicy,
  profileOf: (id: ProviderId) => TranscriptionProfile,
): string[] {
  return policy.providers.flatMap((id) => {
    const gap = providerGaps(s, id);
    const profile = profileOf(id);
    const pgap = profileGaps(profile, s);
    // A provider's audio goes only to its own speech provider: Scaleway's to Whisper, Google's to Gemini.
    const foreign = speechProvidersOf(profile).filter((sp) => sp !== ownSpeech(id));
    const mismatch = foreign.length
      ? [
          `transcription profile ${profile.name} uses ${foreign.join(" and ")}, which is not provider ${id}'s own speech provider (${ownSpeech(id)})`,
        ]
      : [];
    return [...(gap ? [gap] : []), ...(pgap ? [pgap] : []), ...mismatch];
  });
}

/** Whether any provider in the deployment can ground an answer with Google Search. */
export const groundingPossible = (s: LlmSettings, policy: RoutingPolicy): boolean =>
  s.searchGrounding && policy.providers.some((id) => PROVIDERS[id].kind === "vertex");
