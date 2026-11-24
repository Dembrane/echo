import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { type Payer, payer, type RoutingNote, withRouting } from "@dembrane/observability";
import { echoOptions } from "./compat";
import type { Completer, Completion, CompletionRequest, Embedder } from "./complete";
import { FallbackModel, type Recheck } from "./fallback";
import type { ModelGroup, Models } from "./models";
import { PROVIDERS, type ProviderId, type RoutingPolicy } from "./providers";

/** Where one call goes, and why; what the call log keeps. */
export interface RouteDecision extends RoutingNote {
  readonly provider: ProviderId;
}

/**
 * Says which provider the calls of a payer go to. It reads the account's setting fresh for
 * every decision that reaches a provider needing an opt-in; only a decision for the default
 * may come from a cache.
 */
export type ProviderResolver = (who: Payer | undefined) => Promise<RouteDecision>;

/** The decision for anything that cannot be resolved: the environment's default, never a guess. */
export function failClosed(policy: RoutingPolicy, cause: string): RouteDecision {
  return {
    provider: policy.default,
    organisationId: null,
    reason: `fail-closed:${cause}`,
    allowed: null,
  };
}

/** The resolver that always answers the default, for a deployment with one provider. */
export const onlyProvider =
  (policy: RoutingPolicy): ProviderResolver =>
  async () => ({
    provider: policy.default,
    organisationId: null,
    reason: "only-provider",
    allowed: null,
  });

/**
 * Asks the resolver for the current payer's decision. A resolver that throws, a payer that
 * names nothing, or an answer for a provider this deployment lacks all give the default.
 */
export async function decide(
  resolver: ProviderResolver,
  policy: RoutingPolicy,
  who: Payer | undefined = payer(),
): Promise<RouteDecision> {
  let d: RouteDecision;
  try {
    d = await resolver(who);
  } catch {
    return failClosed(policy, "lookup-error");
  }
  return policy.providers.includes(d.provider) ? d : failClosed(policy, "provider-missing");
}

const noteOf = (d: RouteDecision): RoutingNote => ({
  organisationId: d.organisationId,
  provider: d.provider,
  reason: d.reason,
  allowed: d.allowed,
});

/** Runs `fn` as the decision says: inside its routing note, so the call log records it. */
export const routed = <T>(d: RouteDecision, fn: () => T): T => withRouting(noteOf(d), fn);

type Registry = Readonly<Partial<Record<ProviderId, Models>>>;

/**
 * One model name that sends each call to the provider its payer resolves to. The group's
 * fallback list belongs to the provider chosen: a call routed to Scaleway can only ever fall
 * back among Scaleway's models, because Google's are not in its list.
 */
class RoutingLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "echo-routing";
  readonly modelId: string;

  constructor(
    private readonly group: ModelGroup,
    private readonly registry: Registry,
    private readonly policy: RoutingPolicy,
    private readonly resolver: ProviderResolver,
  ) {
    this.modelId = group;
  }

  get supportedUrls() {
    return this.of(this.policy.default).supportedUrls;
  }

  private of(id: ProviderId): LanguageModelV4 {
    const models = this.registry[id] ?? this.registry[this.policy.default];
    if (!models) throw new Error(`no models for provider ${id}`);
    return models.model(this.group);
  }

  /**
   * For a call on a provider that needs an opt-in: before every attempt after the first, the
   * project is asked again, and a call that no longer resolves there moves to its new provider
   * for the rest of its attempts, its rows recording the new decision.
   */
  private recheck(d: RouteDecision, who: Payer | undefined): Recheck | undefined {
    if (!PROVIDERS[d.provider].optIn) return undefined;
    return async () => {
      const now = await decide(this.resolver, this.policy, who);
      if (now.provider === d.provider) return null;
      return { model: this.of(now.provider), note: noteOf(now) };
    };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const who = payer();
    const d = await decide(this.resolver, this.policy, who);
    const model = this.of(d.provider);
    return routed(d, () =>
      model instanceof FallbackModel
        ? model.doGenerate(options, this.recheck(d, who))
        : model.doGenerate(options),
    );
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const who = payer();
    const d = await decide(this.resolver, this.policy, who);
    const model = this.of(d.provider);
    return routed(d, () =>
      model instanceof FallbackModel
        ? model.doStream(options, this.recheck(d, who))
        : model.doStream(options),
    );
  }
}

/** The embedding model of the provider the payer resolves to. */
class RoutingEmbeddingModel implements EmbeddingModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "echo-routing";
  readonly modelId = "embedding";

  constructor(
    private readonly registry: Registry,
    private readonly policy: RoutingPolicy,
    private readonly resolver: ProviderResolver,
  ) {}

  private of(id: ProviderId): EmbeddingModelV4 {
    const models = this.registry[id] ?? this.registry[this.policy.default];
    if (!models) throw new Error(`no models for provider ${id}`);
    return models.embedding().model;
  }

  get maxEmbeddingsPerCall() {
    return this.of(this.policy.default).maxEmbeddingsPerCall;
  }
  get supportsParallelCalls() {
    return this.of(this.policy.default).supportsParallelCalls;
  }

  async doEmbed(options: Parameters<EmbeddingModelV4["doEmbed"]>[0]) {
    const d = await decide(this.resolver, this.policy);
    return routed(d, () => this.of(d.provider).doEmbed(options));
  }
}

/**
 * The models every feature package receives, in place of one provider's. Each call asks
 * which project it is for (the payer context every request, job and workflow already
 * carries) and goes to that project's provider. `registry` holds one `Models` per provider
 * the deployment has; `resolver` is the policy.
 */
export function routingModels(
  registry: Registry,
  policy: RoutingPolicy,
  resolver: ProviderResolver,
): Models {
  const def = registry[policy.default];
  if (!def) throw new Error(`the default provider ${policy.default} has no models`);
  const groups = new Map<ModelGroup, LanguageModelV4>();
  const embedding = new RoutingEmbeddingModel(registry, policy, resolver);
  return {
    model: (g) => {
      let m = groups.get(g);
      if (!m) {
        m = new RoutingLanguageModel(g, registry, policy, resolver);
        groups.set(g, m);
      }
      return m;
    },
    embedding: () => ({ model: embedding, dimensions: def.embedding().dimensions }),
    // Provider options naming the spoken language; the Gemini models ignore them.
    speechHint: echoOptions,
  };
}

type Completers = Readonly<Partial<Record<ProviderId, Completer>>>;

/** The completer that hands each request to the completer of the provider its payer resolves to. */
export function routingCompleter(
  completers: Completers,
  policy: RoutingPolicy,
  resolver: ProviderResolver,
): Completer {
  const of = (id: ProviderId) => {
    const c = completers[id] ?? completers[policy.default];
    if (!c) throw new Error(`no completer for provider ${id}`);
    return c;
  };
  return {
    async complete(request: CompletionRequest): Promise<Completion> {
      const d = await decide(resolver, policy);
      return routed(d, () => of(d.provider).complete(request));
    },
    modelIdentity: (group) => of(policy.default).modelIdentity(group),
    async identityOf(group) {
      const d = await decide(resolver, policy);
      return of(d.provider).modelIdentity(group);
    },
    async grounds() {
      const d = await decide(resolver, policy);
      return (await of(d.provider).grounds?.()) ?? true;
    },
  };
}

type Embedders = Readonly<Partial<Record<ProviderId, Embedder>>>;

/** The embedder of the provider the payer resolves to; its identity keys the project's stored vectors. */
export function routingEmbedder(
  embedders: Embedders,
  policy: RoutingPolicy,
  resolver: ProviderResolver,
): Embedder {
  const of = (id: ProviderId) => {
    const e = embedders[id] ?? embedders[policy.default];
    if (!e) throw new Error(`no embedder for provider ${id}`);
    return e;
  };
  const base = of(policy.default);
  return {
    model: base.model,
    endpoint: base.endpoint,
    get dimensions() {
      return base.dimensions;
    },
    async identity() {
      const e = of((await decide(resolver, policy)).provider);
      return { model: e.model, endpoint: e.endpoint };
    },
    async embed(text) {
      const d = await decide(resolver, policy);
      return routed(d, () => of(d.provider).embed(text));
    },
  };
}
