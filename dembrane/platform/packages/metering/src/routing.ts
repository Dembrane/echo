import type { Db } from "@dembrane/db";
import {
  accountProviders,
  allowedAmong,
  failClosed,
  type Job,
  type PerJob,
  PROVIDERS,
  type ProviderId,
  type ProviderResolver,
  type RouteDecision,
  type RoutingPolicy,
} from "@dembrane/llm";
import { type Payer, type PayerRefKind, payerKey } from "@dembrane/observability";
import { sql } from "drizzle-orm";
import { projectOfPayer, validId } from "./resolve";

/**
 * What the database says about the project a payer leads to, read for one decision. Only the
 * organisation that owns the project's workspace speaks for the account: the billing
 * account that pays says nothing here, because a partner can pay for a client's workspace and
 * the client's allowance still decides where its data goes.
 */
export interface RoutingFacts {
  readonly organisationId: string;
  /** org.ai_transcription_providers and org.ai_analysis_providers: what the account has enabled per job; null when staff never set it. */
  readonly enabled: PerJob<readonly string[] | null>;
  /** org.ai_transcription_default and org.ai_analysis_default. */
  readonly defaults: PerJob<string | null>;
  /** project.ai_transcription_provider and ai_analysis_provider; null follows the account default (always null for a workspace payer). */
  readonly projectChoices: PerJob<string | null>;
  /** conversation.ai_transcription_provider when the call belongs to a conversation; undefined when it does not. */
  readonly conversationProvider?: string | null | undefined;
  /** The conversation the payer is or belongs to; undefined when the payer is not one. */
  readonly conversationId?: string | undefined;
}

/** Reads the facts; null for a payer that leads to no live project or workspace. */
export interface RoutingStore {
  facts(who: Extract<Payer, { ref: PayerRefKind }>): Promise<RoutingFacts | null>;
}

type FactsRow = {
  org_id: string;
  transcription_providers: string[] | null;
  analysis_providers: string[] | null;
  transcription_default: string | null;
  analysis_default: string | null;
  transcription_choice: string | null;
  analysis_choice: string | null;
};

/** The production store: the project, its workspace's organisation and, for a conversation, its own record. */
export function dbRoutingStore(db: Db): RoutingStore {
  const ofProject = async (projectId: string) => {
    const rows = await db.execute<FactsRow>(sql`
      select o.id::text as org_id,
        o.ai_transcription_providers as transcription_providers, o.ai_analysis_providers as analysis_providers,
        o.ai_transcription_default as transcription_default, o.ai_analysis_default as analysis_default,
        p.ai_transcription_provider as transcription_choice, p.ai_analysis_provider as analysis_choice
      from project p
      join workspace w on w.id = p.workspace_id
      join org o on o.id = w.org_id
      where p.id = ${projectId}::uuid
        and p.deleted_at is null and w.deleted_at is null and o.deleted_at is null`);
    return rows[0] ?? null;
  };
  const ofWorkspace = async (workspaceId: string) => {
    const rows = await db.execute<FactsRow>(sql`
      select o.id::text as org_id,
        o.ai_transcription_providers as transcription_providers, o.ai_analysis_providers as analysis_providers,
        o.ai_transcription_default as transcription_default, o.ai_analysis_default as analysis_default,
        null::varchar as transcription_choice, null::varchar as analysis_choice
      from workspace w join org o on o.id = w.org_id
      where w.id = ${workspaceId}::uuid and w.deleted_at is null and o.deleted_at is null`);
    return rows[0] ?? null;
  };
  const conversationOf = async (who: { ref: PayerRefKind; id: string }) => {
    const id = who.id.toLowerCase();
    type Row = { id: string; project_id: string; ai_provider: string | null };
    if (who.ref === "conversation") {
      const rows = await db.execute<Row>(
        sql`select id::text as id, project_id::text as project_id, ai_transcription_provider as ai_provider from conversation where id = ${id}::uuid`,
      );
      return rows[0] ?? null;
    }
    const rows = await db.execute<Row>(sql`
      select c.id::text as id, c.project_id::text as project_id, c.ai_transcription_provider as ai_provider
      from conversation_artifact a join conversation c on c.id = a.conversation_id
      where a.id = ${id}::uuid`);
    return rows[0] ?? null;
  };
  const toFacts = (
    r: FactsRow,
    conversationProvider?: string | null,
    conversationId?: string,
  ): RoutingFacts => ({
    organisationId: r.org_id,
    enabled: { transcription: r.transcription_providers, analysis: r.analysis_providers },
    defaults: { transcription: r.transcription_default, analysis: r.analysis_default },
    projectChoices: { transcription: r.transcription_choice, analysis: r.analysis_choice },
    ...(conversationProvider !== undefined && { conversationProvider }),
    ...(conversationId !== undefined && { conversationId }),
  });
  return {
    async facts(who) {
      const id = who.id.toLowerCase();
      if (!validId(who.ref, id)) return null;
      if (who.ref === "workspace") {
        const r = await ofWorkspace(id);
        return r && toFacts(r);
      }
      if (who.ref === "conversation" || who.ref === "verify_artifact") {
        const conv = await conversationOf(who);
        if (!conv) return null;
        const r = await ofProject(conv.project_id);
        return r && toFacts(r, conv.ai_provider, conv.id);
      }
      const projectId = await projectOfPayer(db, who);
      if (!projectId) return null;
      const r = await ofProject(projectId);
      return r && toFacts(r);
    },
  };
}

export interface ResolverOptions {
  /** How long a decision for a provider that needs no opt-in may be reused. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly maxCached?: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_CACHED = 10_000;

/** The reasons that describe a settled setting, and so may be remembered while they say "no opt-in". */
const CACHEABLE = new Set(["project", "account-default", "environment-default", "conversation"]);

/**
 * The routing policy. The deployment's configuration says which providers exist and which is
 * the default; the account's allowed list and default and the project's choice pick among
 * those. Anything it cannot read positively resolves to the default.
 *
 * Only a decision for a provider that needs no opt-in is remembered, and only briefly: a
 * decision for Google is read fresh every time, so switching a project or an account back
 * applies to the very next call. A remembered "no Google" can only delay the start of Google.
 */
export function providerResolver(
  store: RoutingStore,
  policy: RoutingPolicy,
  opts: ResolverOptions = {},
): ProviderResolver {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const max = opts.maxCached ?? DEFAULT_MAX_CACHED;
  const cache = new Map<string, { until: number; decision: RouteDecision }>();

  return async (who, job) => {
    if (!who) return failClosed(policy, "no-payer", job);
    if (!("ref" in who)) return failClosed(policy, "internal", job);
    if (policy.providers.length === 1)
      return {
        provider: policy.default,
        job,
        organisationId: null,
        reason: "only-provider",
        allowed: null,
      };
    const key = `${job}:${payerKey(who)}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.decision;
    const facts = await store.facts(who);
    if (!facts) return failClosed(policy, "unknown-project", job);
    const d = resolve(policy, facts, job);
    if (!PROVIDERS[d.provider].optIn && CACHEABLE.has(d.reason)) {
      if (cache.size >= max) cache.clear();
      cache.set(key, { until: now() + ttl, decision: d });
    } else cache.delete(key);
    return d;
  };
}

/**
 * The pure decision over what the database said, for one job. The account's enabled providers
 * that serve the job are the only candidates: the project's choice, else the account's default
 * for the job, else the environment's default. A conversation's own start binds transcription
 * only; analysis decides at every call.
 */
export function resolve(policy: RoutingPolicy, f: RoutingFacts, job: Job): RouteDecision {
  const account = accountProviders(policy, { enabled: f.enabled, defaults: f.defaults }, job);
  const eligible = account.enabled;
  const base = {
    organisationId: f.organisationId,
    job,
    allowed: eligible,
    ...(f.conversationId !== undefined && { conversationId: f.conversationId }),
  } as const;
  if (!account.default)
    return { ...base, provider: policy.default, reason: "fail-closed:nothing-allowed" };

  const chosen = allowedAmong(policy, [f.projectChoices[job]])[0];
  const picked = chosen && eligible.includes(chosen) ? chosen : null;
  let provider: ProviderId = picked ?? account.default;
  let reason = picked ? "project" : account.named ? "account-default" : "environment-default";

  // A conversation's audio reaches a provider that needs an opt-in only if the conversation
  // began there. A conversation that began elsewhere stays out until it ends.
  if (
    job === "transcription" &&
    f.conversationProvider !== undefined &&
    PROVIDERS[provider].optIn &&
    f.conversationProvider !== provider
  ) {
    const began = allowedAmong(policy, [f.conversationProvider])[0];
    const safe =
      (began && eligible.includes(began) && !PROVIDERS[began].optIn ? began : null) ??
      (eligible.includes(policy.default) && !PROVIDERS[policy.default].optIn
        ? policy.default
        : null) ??
      eligible.find((id) => !PROVIDERS[id].optIn) ??
      null;
    provider = safe ?? policy.default;
    reason = safe ? "conversation" : "fail-closed:conversation";
  }
  return { ...base, provider, reason };
}
