import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { type Payer, payer, type RoutingNote, withRouting } from "@dembrane/observability";
import { echoOptions } from "./compat";
import {
  type Completer,
  type Completion,
  type CompletionRequest,
  type Embedder,
  EmbeddingRouteChanged,
  type PinnedEmbedder,
} from "./complete";
import { watched } from "./fallback";
import type { ModelGroup, Models } from "./models";
import {
  fallsBackTo,
  type Job,
  PROVIDERS,
  type ProviderId,
  type RoutingPolicy,
  serves,
} from "./providers";

/** Where one call goes, and why; what the call log keeps. */
export interface RouteDecision extends RoutingNote {
  readonly provider: ProviderId;
  readonly job: Job;
}

/**
 * Says which provider the calls of a payer go to. It reads the account's setting fresh for
 * every decision that reaches a provider needing an opt-in; only a decision for the default
 * may come from a cache.
 */
export type ProviderResolver = (who: Payer | undefined, job: Job) => Promise<RouteDecision>;

/** The decision for anything that cannot be resolved: the environment's default, never a guess. */
export function failClosed(policy: RoutingPolicy, cause: string, job: Job): RouteDecision {
  return {
    provider: policy.default,
    job,
    organisationId: null,
    reason: `fail-closed:${cause}`,
    allowed: null,
  };
}

/** The resolver that always answers the default, for a deployment with one provider. */
export const onlyProvider =
  (policy: RoutingPolicy): ProviderResolver =>
  async (_who, job) => ({
    provider: policy.default,
    job,
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
  job: Job,
  who: Payer | undefined = payer(),
): Promise<RouteDecision> {
  let d: RouteDecision;
  try {
    d = await resolver(who, job);
  } catch {
    return failClosed(policy, "lookup-error", job);
  }
  // A provider the deployment lacks, or one that does not serve the job, is never used.
  return policy.providers.includes(d.provider) && serves(d.provider, job) && d.job === job
    ? d
    : failClosed(policy, "provider-missing", job);
}

const noteOf = (d: RouteDecision): RoutingNote => ({
  organisationId: d.organisationId,
  provider: d.provider,
  job: d.job,
  reason: d.reason,
  allowed: d.allowed,
  conversationId: d.conversationId ?? null,
});

/** Runs `fn` as the decision says: inside its routing note, so the call log records it. */
export const routed = <T>(d: RouteDecision, fn: () => T): T => withRouting(noteOf(d), fn);

/** The project of a call left its provider while the call was retrying; `rerouted` runs it again where it belongs now. */
export class RouteMoved extends Error {
  override name = "RouteMoved";
  readonly isRetryable = false;
  constructor(
    readonly scope: object,
    readonly to: RouteDecision,
  ) {
    super(`the call's provider changed to ${to.provider} while it was retrying`);
  }
}

/** How many times one call may be moved before it fails instead. */
const MAX_MOVES = 3;

/**
 * Runs a call as `first` decided, and for a provider that needs an opt-in decides again before
 * every attempt after the first (a retry, the next deployment, the next model group, the second
 * pass over the same audio). When the call no longer resolves there it is run again from the
 * start on the new decision, which its rows record: a project that moved back to Scaleway never
 * sends the next attempt to Google. Every path that retries a call for a Google-routed payer
 * goes through here; `run` is the one call, made for the decision it is given.
 */
export async function rerouted<T>(
  first: RouteDecision,
  decideNow: () => Promise<RouteDecision>,
  run: (decision: RouteDecision) => PromiseLike<T>,
): Promise<T> {
  let at = first;
  for (let moves = 0; ; moves++) {
    const here = at;
    const scope = {};
    const recheck = PROVIDERS[here.provider].optIn
      ? async () => {
          const now = await decideNow();
          if (now.provider !== here.provider) throw new RouteMoved(scope, now);
        }
      : null;
    try {
      return await routed(here, () => watched(recheck, () => run(here)));
    } catch (err) {
      if (!(err instanceof RouteMoved) || err.scope !== scope || moves >= MAX_MOVES) throw err;
      at = err.to;
    }
  }
}

/** Media types of a file part that carry no recording: pictures, text and documents. */
const NOT_A_RECORDING = /^(image\/|text\/|application\/(pdf|json)$)/;

/**
 * Which job a language-model call is. A request that carries audio (or any file that is not a
 * picture, text or a document) is a transcription of its conversation, whatever model group
 * asked for it: it is decided, and logged, as transcription, so recordings only ever reach a
 * provider the account enabled for transcription. Every other call is analysis.
 */
export function jobOfPrompt(prompt: LanguageModelV4Prompt): Job {
  const carriesRecording = prompt.some(
    (m) =>
      m.role !== "system" &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "file" && !NOT_A_RECORDING.test(p.mediaType)),
  );
  return carriesRecording ? "transcription" : "analysis";
}

/**
 * Whether a decision lets a call fall back to the models of another provider: only when the
 * account has every such provider enabled for the call's job. Anything not positively
 * resolved (`allowed` null) has no fallback.
 */
const mayFallBack = (d: RouteDecision) =>
  fallsBackTo(d.provider).every((id) => d.allowed?.includes(id) ?? false);

/** The models or completer of a provider, without its fallback tail when the decision does not allow it. */
const within = <T extends { readonly standalone?: T | undefined }>(x: T, d: RouteDecision): T =>
  mayFallBack(d) ? x : (x.standalone ?? x);

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
    const models = this.registry[this.policy.default];
    if (!models) throw new Error(`no models for provider ${this.policy.default}`);
    return models.model(this.group).supportedUrls;
  }

  private of(d: RouteDecision): LanguageModelV4 {
    const models = this.registry[d.provider] ?? this.registry[this.policy.default];
    if (!models) throw new Error(`no models for provider ${d.provider}`);
    return within(models, d).model(this.group);
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const who = payer();
    const job = jobOfPrompt(options.prompt);
    const d = await decide(this.resolver, this.policy, job, who);
    return rerouted(
      d,
      () => decide(this.resolver, this.policy, job, who),
      (at) => this.of(at).doGenerate(options),
    );
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const who = payer();
    const job = jobOfPrompt(options.prompt);
    const d = await decide(this.resolver, this.policy, job, who);
    return rerouted(
      d,
      () => decide(this.resolver, this.policy, job, who),
      (at) => this.of(at).doStream(options),
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
    const d = await decide(this.resolver, this.policy, "analysis");
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
  const of = (d: RouteDecision) => {
    const c = completers[d.provider] ?? completers[policy.default];
    if (!c) throw new Error(`no completer for provider ${d.provider}`);
    return within(c, d);
  };
  const def = (id: ProviderId) => {
    const c = completers[id] ?? completers[policy.default];
    if (!c) throw new Error(`no completer for provider ${id}`);
    return c;
  };
  return {
    async complete(request: CompletionRequest): Promise<Completion> {
      const who = payer();
      const d = await decide(resolver, policy, "analysis", who);
      return rerouted(
        d,
        () => decide(resolver, policy, "analysis", who),
        (at) => of(at).complete(request),
      );
    },
    modelIdentity: (group) => def(policy.default).modelIdentity(group),
    async identityOf(group) {
      const d = await decide(resolver, policy, "analysis");
      return of(d).modelIdentity(group);
    },
    async grounds() {
      const d = await decide(resolver, policy, "analysis");
      return (await of(d).grounds?.()) ?? true;
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
  const pinned = async (): Promise<PinnedEmbedder> => {
    const who = payer();
    const d = await decide(resolver, policy, "analysis", who);
    const e = of(d.provider);
    // Checked on both sides of the call: nothing is sent to the old provider after the
    // project moved, and nothing the old provider made is kept after it.
    const same = async () => {
      const now = await decide(resolver, policy, "analysis", who);
      if (now.provider !== d.provider) throw new EmbeddingRouteChanged(d.provider, now.provider);
    };
    return {
      provider: d.provider,
      identity: { model: e.model, endpoint: e.endpoint, baseUrl: e.baseUrl },
      hold: e,
      async embed(text) {
        await same();
        const vector = await routed(d, () => e.embed(text));
        await same();
        return vector;
      },
    };
  };
  return {
    model: base.model,
    endpoint: base.endpoint,
    get dimensions() {
      return base.dimensions;
    },
    async identity() {
      return (await pinned()).identity;
    },
    pinned,
    async embed(text) {
      const d = await decide(resolver, policy, "analysis");
      return routed(d, () => of(d.provider).embed(text));
    },
  };
}
