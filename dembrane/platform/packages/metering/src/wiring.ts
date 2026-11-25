import type { Db } from "@dembrane/db";
import {
  createRegistry,
  type LlmSettings,
  type ModelHooks,
  type ProviderKit,
  type ProviderResolver,
  profileForProvider,
  type Registry,
  type RoutingPolicy,
  routedKit,
  routingPolicyOf,
} from "@dembrane/llm";
import { dbRoutingStore, providerResolver, type ResolverOptions } from "./routing";

/** The deployment's AI as the apps compose it: what exists, who chooses, and what the features receive. */
export interface AiRouting {
  readonly policy: RoutingPolicy;
  /** One kit per provider the deployment has. */
  readonly registry: Registry;
  readonly resolver: ProviderResolver;
  /** The models, completer and embedder every feature receives; each call goes where its payer resolves. */
  readonly kit: ProviderKit;
  readonly profileOf: ReturnType<typeof profileFor>;
}

const profileFor = (s: LlmSettings) => (id: Parameters<typeof profileForProvider>[1]) =>
  profileForProvider(s, id);

/**
 * Builds a model set per provider the configuration lists and the policy that sends each
 * call to one of them. The configuration decides what exists: the database, read at call
 * time, can only choose among it. With one provider nothing is read from the database.
 */
export function aiRouting(o: {
  settings: LlmSettings;
  db: Db;
  hooks?: ModelHooks;
  resolverOptions?: ResolverOptions;
  /** Replaces the database policy; tests. */
  resolver?: ProviderResolver;
}): AiRouting {
  const policy = routingPolicyOf(o.settings);
  const profileOf = profileFor(o.settings);
  const registry = createRegistry(o.settings, policy, profileOf, o.hooks);
  const resolver = o.resolver ?? providerResolver(dbRoutingStore(o.db), policy, o.resolverOptions);
  return { policy, registry, resolver, kit: routedKit(registry, policy, resolver), profileOf };
}
