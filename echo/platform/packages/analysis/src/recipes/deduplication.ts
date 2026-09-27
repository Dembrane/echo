import type { Json, ObjectRevision, SourceRef } from "../contracts";
import { EmbeddingService, identityKey, inputHash, refJson } from "../embeddings";
import { type RecipeContext, RecipeFailed, stepResult } from "../executor";
import { contentHash, type PyFloat, sha256Hex } from "../hashing";
import verifyPrompt from "../prompts/dedup-verify-v2.md" with { type: "text" };
import { compareLists, type Recipe, type StepDef } from "../registry";
import { s, validateAgainst, withDefault } from "../schema";
import { casefold, normKey } from "../text";
import { getObjectType } from "../types";
import {
  argumentOrder,
  artifactHash,
  fresh,
  liveModelDeployment,
  revisionQuotes,
} from "./arguments";
import {
  AccountingError,
  assembleResult,
  buildRequest,
  CANDIDATE_STRATEGY,
  CANDIDATE_STRATEGY_VERSION,
  type CandidateGroup,
  callFailed,
  checkAnswer,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_CANDIDATE_GROUPS,
  DEFAULT_MAX_GROUP_SIZE,
  type DeduplicationResult,
  discoverCandidates,
  discoveryDoc,
  type GroupCheck,
  InvalidInput,
  lineageKey,
  MAX_QUOTES_SHOWN,
  RECIPE_ID,
  RECIPE_VERSION,
  resultItems,
  type SourceArgument,
  VALENCES,
  VERDICTS,
  VERIFY_PROMPT,
  type VerificationRequest,
  verificationStatus,
  verificationUserText,
} from "./deduplication-core";
import { AnswerDidNotParse, jsonFromText } from "./model";
import { modelDeployment, type ProducerServices, producerServices } from "./services";

/**
 * Deduplicated arguments as a recipe: discovery (deterministic, recomputed and saved),
 * one cached model step per candidate group, assembly as the accounting check, then
 * embeddings of the output statements. Each output is a deduplicated_argument derived
 * from every member it stands for; unverified groups stay apart and are listed.
 */

export const VERIFY_PROMPT_TEXT: string = verifyPrompt;
export const ACCOUNTING_CHECK = "dedup-accounting-v1";
export const VERIFY_MAX_TOKENS = 16_000;
export const VERIFY_TIMEOUT_MS = 180_000;
export const VERIFY_ATTEMPTS = 2;

const CHECK_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["member", "judgement", "note"],
  properties: {
    member: { type: "string" },
    judgement: { type: "string", enum: [...VERDICTS] },
    note: { type: "string" },
  },
};

/** Nested maxItems makes Vertex reject the whole schema, so sizes are checked in code. */
export const RESPONSE_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["members", "proposed_statement", "checks", "verdict", "rationale"],
        properties: {
          members: { type: "array", minItems: 1, items: { type: "string" } },
          proposed_statement: { type: "string" },
          checks: { type: "array", items: CHECK_SCHEMA },
          verdict: { type: "string", enum: [...VERDICTS] },
          rationale: { type: "string" },
        },
      },
    },
  },
};

/** The exact prompt text a cache key names. */
export const promptFingerprint = () => sha256Hex(VERIFY_PROMPT_TEXT);

/**
 * One verification call for one candidate group: the parsed answer and token usage
 * summed over attempts, with `attempts`. Retried once on a timeout or an unparsable
 * answer; checkAnswer judges the content.
 */
export async function verifyWithModel(
  services: ProducerServices,
  request: VerificationRequest,
): Promise<[Json, Record<string, number>]> {
  const userText = verificationUserText(request);
  const usage: Record<string, number> = { attempts: 0 };
  let last: unknown;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    usage.attempts = attempt;
    try {
      const response = await services.complete({
        system: VERIFY_PROMPT_TEXT,
        user: userText,
        temperature: 0,
        maxTokens: VERIFY_MAX_TOKENS,
        jsonSchema: RESPONSE_SCHEMA,
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      for (const [name, value] of Object.entries(response.usage))
        usage[name] = (usage[name] ?? 0) + value;
      return [jsonFromText(response.text), usage];
    } catch (err) {
      // Python retried a ValueError (an answer that did not parse) or a timeout, nothing else.
      if (!(err instanceof AnswerDidNotParse) && (err as Error)?.name !== "TimeoutError") throw err;
      last = err;
      if (attempt < VERIFY_ATTEMPTS) await Bun.sleep(2000 * attempt);
    }
  }
  throw last;
}

const STEPS: StepDef[] = [
  {
    key: "discover",
    version: "1",
    kind: "deterministic",
    description:
      "Propose candidate groups by complete linkage on statement embeddings, within one kind and valence",
  },
  {
    key: "verify",
    version: "1",
    kind: "model",
    description:
      "Verify one candidate group: sub-groups, each proposed statement checked against every member",
    promptRef: `dembrane/analysis/prompts/${VERIFY_PROMPT}.md`,
    promptVersion: VERIFY_PROMPT,
  },
  {
    key: "assemble",
    version: "1",
    kind: "check",
    description:
      "Merge only fully verified sub-groups and account for every input revision exactly once",
    checkVersion: ACCOUNTING_CHECK,
  },
  {
    key: "embed",
    version: "1",
    kind: "deterministic",
    description: "Embed each output statement, reusing stored vectors",
  },
];

const PARAMETERS = {
  name: "DeduplicationParameters",
  fields: [
    withDefault("similarity_threshold", s.opt(s.float({ gt: 0, le: 1 })), null),
    withDefault("max_group_size", s.int({ ge: 2, le: 64 }), DEFAULT_MAX_GROUP_SIZE),
    withDefault("max_candidate_groups", s.int({ ge: 0, le: 5000 }), DEFAULT_MAX_CANDIDATE_GROUPS),
  ],
};

function mergedEvidence(members: readonly ObjectRevision[]): Json[] {
  const byConversation = new Map<string, Json & { quotes: string[] }>();
  for (const m of members)
    for (const item of (m.payload.evidence as Json[] | undefined) ?? []) {
      const key = String(item.conversationId);
      let entry = byConversation.get(key);
      if (!entry) {
        entry = {
          conversationId: item.conversationId,
          label: item.label ?? null,
          createdAt: item.createdAt ?? null,
          quotes: [],
        };
        byConversation.set(key, entry);
      }
      const known = new Set(entry.quotes.map(casefold));
      for (const quote of (item.quotes as string[] | undefined) ?? [])
        if (!known.has(casefold(quote))) {
          entry.quotes.push(quote);
          known.add(casefold(quote));
        }
    }
  return [...byConversation.values()];
}

function mergedRefs(members: readonly ObjectRevision[]): SourceRef[] {
  const refs = new Map<string, SourceRef>();
  for (const m of members)
    for (const ref of revisionQuotes(m)) {
      const key = `${ref.conversationId}\x1f${normKey(ref.quote ?? "")}`;
      if (!refs.has(key)) refs.set(key, ref);
    }
  return [...refs.values()];
}

/** The embedding model behind the pinned vectors, which selects the calibrated threshold. */
async function embeddingModel(
  ctx: RecipeContext,
  refs: readonly Json[],
  configKey: string,
): Promise<string> {
  const named = new Set(refs.filter((r) => r.model).map((r) => String(r.model)));
  if (named.size === 1) return [...named][0] as string;
  const identity = await producerServices(ctx.services).probe();
  return identityKey(identity) === configKey ? identity.model : "unknown";
}

async function execute(ctx: RecipeContext): Promise<void> {
  const services = producerServices(ctx.services);
  const deployment = liveModelDeployment(ctx);
  const validated = validateAgainst(PARAMETERS, { ...ctx.parameters }, false);
  if (!validated.ok) throw new RecipeFailed("The deduplication parameters are invalid.");
  const parameters = validated.value;
  const revisions = (await ctx.inputRevisions("arguments")).sort((a, b) =>
    compareLists(argumentOrder(a), argumentOrder(b)),
  );
  if (revisions.some((r) => r.type !== "argument"))
    throw new RecipeFailed("Deduplication reads arguments only.");
  const refs = revisions.map((r) => r.embeddingRefs ?? {});
  const configs = new Set(refs.map((r) => String(r.configKey)));
  if (refs.some((r) => !r.embeddingId || !r.configKey) || configs.size > 1)
    throw new RecipeFailed(
      "The arguments do not share one stored embedding configuration. Refresh the arguments.",
    );
  if (revisions.some((r) => !VALENCES.includes(r.payload.valence as string)))
    throw new RecipeFailed(
      "Some arguments have no valence, so they cannot be compared. Refresh the arguments.",
    );
  const configKey = revisions.length ? ([...configs][0] as string) : "";
  const vectors = await ctx.store.vectorsByIds(
    ctx.projectId,
    refs.map((r) => String(r.embeddingId)),
  );
  if (vectors.size !== new Set(refs.map((r) => String(r.embeddingId))).size)
    throw new RecipeFailed("Some arguments' vectors are missing. Refresh the arguments.");
  const model = revisions.length ? await embeddingModel(ctx, refs, configKey) : "unknown";

  const sources: SourceArgument[] = revisions.map((r, i) => ({
    revision_id: r.id,
    object_id: r.objectId,
    statement: String(r.payload.statement),
    epistemic_kind: String(r.payload.epistemicKind),
    valence: String(r.payload.valence),
    evidence: revisionQuotes(r).map((ref) => ({
      conversation_id: ref.conversationId,
      quote: ref.quote ?? "",
      location: null,
    })),
    embedding: vectors.get(String(refs[i]?.embeddingId)) as number[],
    embedding_config_key: configKey,
  }));
  const threshold = parameters.similarity_threshold as PyFloat | null;
  const params = {
    embeddingModel: model,
    similarityThreshold: threshold === null ? null : threshold.value,
    maxGroupSize: Number(parameters.max_group_size),
    maxCandidateGroups: Number(parameters.max_candidate_groups),
    concurrency: ctx.recipe.modelConcurrency ?? DEFAULT_CONCURRENCY,
  };
  let discovery: ReturnType<typeof discoverCandidates>;
  try {
    discovery = discoverCandidates(sources, params);
  } catch (err) {
    if (err instanceof InvalidInput)
      throw new RecipeFailed(`The arguments cannot be deduplicated: ${err.message}`);
    throw err;
  }

  // 1. discovery: recomputed (cheap and exact), saved as the artifact
  const doc = discoveryDoc(discovery);
  await ctx.step("discover", async () => stepResult({ output: doc }), {
    inputs: {
      revisionIds: revisions.map((r) => r.id),
      embeddingConfigKey: configKey,
      embeddingModel: model,
      strategy: CANDIDATE_STRATEGY,
      strategyVersion: CANDIDATE_STRATEGY_VERSION,
      parameters,
    },
  });
  await ctx.progress("verifying", {
    force: true,
    counts: { groups_total: discovery.groups.length },
  });

  // 2. one model step per candidate group
  const byRevision = new Map(sources.map((x) => [x.revision_id, x]));
  const prompt = { id: VERIFY_PROMPT, fingerprint: promptFingerprint() };
  const verifyHashes = new Map<string, string>();
  const checks: GroupCheck[] = new Array(discovery.groups.length);
  const verifyGroup = async (group: CandidateGroup, index: number) => {
    const request = buildRequest(group, byRevision);
    const output = await ctx.step<Json>(
      "verify",
      async () => {
        let raw: Json;
        let usage: Record<string, number>;
        try {
          [raw, usage] = await verifyWithModel(services, request);
        } catch (err) {
          // The group stays apart; a regenerate asks again.
          const name = (err as Error)?.constructor?.name ?? "Error";
          ctx.deps.logger?.warn(
            { group_id: group.group_id, error: name },
            "deduplication verification failed",
          );
          return stepResult({ output: { status: "call_failed", error: name }, modelCalls: 1 });
        }
        const tokens = Object.fromEntries(
          Object.entries(usage).filter(([k]) =>
            ["prompt_tokens", "completion_tokens", "total_tokens"].includes(k),
          ),
        );
        return stepResult({
          output: { status: "answered", answer: raw, usage: { ...usage } },
          usage: tokens,
          modelCalls: Math.trunc(usage.attempts || 1),
        });
      },
      {
        instance: group.group_id,
        inputs: {
          units: group.units.map((u) => [...u]),
          request: contentHash(verificationUserText(request)),
          prompt,
          model: deployment,
        },
      },
    );
    verifyHashes.set(group.group_id, artifactHash(output));
    checks[index] =
      output.status !== "answered"
        ? callFailed(group, String(output.error || "call failed"))
        : checkAnswer(group, request, byRevision, output.answer, {
            ...((output.usage as Record<string, number>) ?? {}),
          });
  };
  const results = await Promise.allSettled(discovery.groups.map((g, i) => verifyGroup(g, i)));
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "several verifications failed");

  // 3. assembly, the accounting check
  let result: DeduplicationResult | null = null;
  let failure: string | null = null;
  try {
    result = assembleResult(sources, discovery, checks);
  } catch (err) {
    if (!(err instanceof AccountingError)) throw err;
    failure = err.message;
  }
  const unverified = checks
    .filter((c) => c.status !== "verified")
    .map((c) => c.group_id)
    .sort();
  await ctx.step(
    "assemble",
    async () => {
      if (!result)
        return stepResult({
          output: { error: failure },
          validation: [
            {
              check: "accounts-for-every-input",
              status: "failed",
              version: ACCOUNTING_CHECK,
              evidence: { inputs: sources.length },
              message: "The output did not hold every input revision exactly once.",
            },
          ],
        });
      const items = resultItems(result);
      const outcomes: Record<string, number> = {};
      for (const item of items)
        outcomes[item.verification.outcome] = (outcomes[item.verification.outcome] ?? 0) + 1;
      return stepResult({
        output: result,
        validation: [
          {
            check: "accounts-for-every-input",
            status: "passed",
            version: ACCOUNTING_CHECK,
            evidence: {
              inputs: sources.length,
              outputs: items.length,
              consolidated: result.consolidated.length,
              singletons: result.singletons.length,
              outcomes: Object.fromEntries(
                Object.keys(outcomes)
                  .sort()
                  .map((k) => [k, outcomes[k]]),
              ),
            },
          },
          {
            check: "candidate-coverage",
            status: "passed",
            version: CANDIDATE_STRATEGY,
            evidence: {
              ...result.coverage,
              unverifiedGroups: unverified,
              skippedGroups: discovery.skipped.map((g) => g.group_id),
            },
            message: unverified.length
              ? `${unverified.length} candidate group(s) were not verified and stayed apart.`
              : null,
          },
        ],
      });
    },
    {
      inputs: {
        check: ACCOUNTING_CHECK,
        revisionIds: revisions.map((r) => r.id),
        discover: artifactHash(doc),
        verify: Object.fromEntries(
          [...verifyHashes.keys()].sort().map((k) => [k, verifyHashes.get(k)]),
        ),
      },
    },
  );
  if (!result) return;
  const final = result;

  // 4. embeddings of the output statements
  await ctx.progress("embedding", { force: true });
  const projection = getObjectType("deduplicated_argument").map;
  if (!projection) throw new Error("deduplicated_argument has no map projection");
  const texts = new Map<string, string>();
  for (const item of resultItems(final))
    texts.set(inputHash(projection.embeddingText({ statement: item.statement })), item.statement);
  const hashes = [...texts.keys()].sort();
  const hits = ctx.metric("cacheHits");
  const resumed = ctx.metric("stepsResumed");
  const embedded = await ctx.step<Json>(
    "embed",
    async () => {
      const stored = texts.size
        ? await ctx.store.loadEmbeddings(ctx.projectId, configKey, hashes)
        : new Map();
      const ids: Record<string, string> = {};
      for (const [hashed, [id]] of stored) ids[hashed] = id;
      const missing = hashes.filter((h) => !stored.has(h));
      let computed = 0;
      if (missing.length) {
        const identity = await services.probe();
        if (identityKey(identity) !== configKey)
          throw new RecipeFailed(
            "The embedding deployment changed since the arguments were embedded. Refresh the arguments first.",
          );
        const service = new EmbeddingService(ctx.store, identity, services.embed);
        const batch = await service.ensure(
          ctx.projectId,
          missing.map((h) => texts.get(h) as string),
        );
        for (const [hashed, id] of batch.ids) ids[hashed] = id;
        computed = batch.computed;
      }
      const unique = new Set(Object.values(ids));
      const durable = await ctx.store.vectorsByIds(ctx.projectId, [...unique].sort());
      if (durable.size !== unique.size)
        throw new RecipeFailed("Saving the output statements' vectors failed.");
      return stepResult({ output: { ids, configKey, reused: stored.size, computed } });
    },
    {
      inputs: {
        embeddingConfigKey: configKey,
        projectionVersion: projection.projectionVersion,
        inputHashes: hashes,
      },
    },
  );
  if (fresh(ctx, hits, resumed)) {
    ctx.count("embeddingsReused", Number(embedded.reused));
    ctx.count("embeddingsComputed", Number(embedded.computed));
  }

  // objects and their lineage
  await ctx.progress("emitting", { force: true });
  const membersById = new Map(revisions.map((r) => [r.id, r]));
  const modelName = model !== "unknown" ? model : null;
  const ids = embedded.ids as Record<string, string>;
  for (const item of resultItems(final)) {
    const members = item.member_revision_ids.map((id) => membersById.get(id) as ObjectRevision);
    const v = item.verification;
    const notes = new Map<string, string>();
    for (const check of v.checks) for (const rid of check.revision_ids) notes.set(rid, check.note);
    const hashed = inputHash(projection.embeddingText({ statement: item.statement }));
    const output = await ctx.emit(
      "deduplicated_argument",
      lineageKey(item.member_object_ids),
      {
        statement: item.statement,
        epistemicKind: item.epistemic_kind,
        valence: item.valence,
        evidence: mergedEvidence(members),
        consolidation: {
          strategy: CANDIDATE_STRATEGY,
          memberCount: item.support_count,
          verification: verificationStatus(v),
          rationale: v.rationale || null,
          coverage: {
            method: v.method,
            outcome: v.outcome,
            verdict: v.verdict,
            groupId: v.group_id,
            checks: v.checks.map((c) => ({
              revisionIds: [...c.revision_ids],
              judgement: c.judgement,
              note: c.note,
            })),
          },
        },
      },
      {
        sourceRefs: mergedRefs(members),
        inputRevisionIds: item.member_revision_ids,
        embeddingRefs: {
          ...refJson({
            embeddingId: ids[hashed] as string,
            inputHash: hashed,
            configKey,
            projectionVersion: projection.projectionVersion,
          }),
          ...(modelName ? { model: modelName } : {}),
        },
      },
    );
    const mergedByModel = v.method === "model" && v.outcome === "merged";
    for (const member of members)
      await ctx.relate("derived_from", output, member, {
        basis: mergedByModel ? "inferred" : "extracted",
        attributes: { rationale: notes.get(member.id) || null },
        sourceRefs: revisionQuotes(member).slice(0, MAX_QUOTES_SHOWN),
      });
  }
  ctx.count("inputs", sources.length);
  ctx.count("outputs", resultItems(final).length);
  ctx.count("consolidated", final.consolidated.length);
  ctx.count("unverifiedGroups", unverified.length);
}

export const RECIPE: Recipe = {
  id: RECIPE_ID,
  version: RECIPE_VERSION,
  name: "Deduplicated arguments",
  purpose:
    "Consolidate arguments that say the same thing into one argument each, verified against every member and derived from each; distinct and minority arguments pass through.",
  inputTypes: ["argument"],
  steps: STEPS,
  outputTypes: ["deduplicated_argument"],
  execute,
  dependencies: () => [{ recipeId: "arguments", scopeKey: "project", name: "arguments" }],
  validationRules: [
    "embedding similarity proposes candidates, never equivalence",
    "a merge needs an equivalent sub-group of one kind and valence, checked against every member",
    "every input revision is in exactly one output, with a derived_from relation to it",
    "unverified candidate groups stay apart and are listed in the coverage check",
  ],
  identityPolicy: {
    description:
      "An output keeps its identity while it stands for the same set of source argument objects.",
  },
  embeddingProjections: ["deduplicated_argument"],
  parameters: PARAMETERS,
  scopeKeyPattern: /^project$/,
  modelConfig: modelDeployment,
  modelConcurrency: DEFAULT_CONCURRENCY,
  // Each step names the argument revisions it read, so an unchanged group is not verified again.
  partitionedInputs: ["revisionIds", "dependencies.arguments"],
};
