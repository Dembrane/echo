import type { Json, ObjectRevision, SourceRef } from "../contracts";
import { EmbeddingService, identityKey, inputHash, refJson } from "../embeddings";
import { type RecipeContext, RecipeFailed, stepResult } from "../executor";
import { contentHash, sha256Hex } from "../hashing";
import { textHash } from "../maprecipe";
import {
  compareLists,
  type InputRequest,
  type Recipe,
  type StepDef,
  sortedStrings,
} from "../registry";
import { required, s } from "../schema";
import { getObjectType } from "../types";
import {
  argumentOrder,
  artifactHash,
  fresh,
  liveModelDeployment,
  loadPinnedTranscripts,
  revisionQuotes,
} from "./arguments";
import { AnswerDidNotParse, jsonFromText } from "./model";
import { modelDeployment, type ProducerServices, producerServices } from "./services";
import {
  type ArgumentRevision,
  COLLISIONS_SCHEMA,
  DEDUPE_PROMPT_NAME,
  MAX_SUPPORTERS_PER_POLE,
  MIN_SUPPORT_STRENGTH,
  namedInputs,
  positionsFromArguments,
  promptVersions,
  RECIPE_ID,
  RECIPE_VERSION,
  runTensions,
  type SourcePassages,
  SUPPORT_SCHEMA,
  type Tension,
  VERIFY_SCHEMA,
  WRITE_SCHEMA,
} from "./tensions-pipeline";
import { DEDUPE_SCHEMA, HANDED_SCHEMA } from "./tensions-stages";

/**
 * Tensions from saved arguments, as a recipe: every judgement of the pipeline becomes a
 * cached model step of its stage, the positions and the review are recorded as checks,
 * and tensions, their embeddings and their supports_pole_a/b relations are emitted
 * against the exact pinned argument revisions. Ported from tensions.py.
 */

export const POSITIONS_CHECK = "evidence-grounded-v2";
export const REVIEW_CHECK = "tensions-review-v2";
const INPUT_TYPES: Readonly<Record<string, string>> = {
  arguments: "argument",
  deduplicated_arguments: "deduplicated_argument",
};
const STAGE_BY_SCHEMA: readonly (readonly [Json, string])[] = [
  [HANDED_SCHEMA, "framing"],
  [COLLISIONS_SCHEMA, "collisions"],
  [VERIFY_SCHEMA, "verify"],
  [DEDUPE_SCHEMA, "dedupe"],
  [SUPPORT_SCHEMA, "support"],
  [WRITE_SCHEMA, "write"],
];
const TOKEN_KEYS = ["prompt_tokens", "completion_tokens", "total_tokens"];
/** Popcorn's analysis judgement: the fast group's token cap and timeout. */
export const ANALYSIS_MAX_TOKENS = 65_536;
export const ANALYSIS_TIMEOUT_MS = 300_000;

const VERSIONS = promptVersions();

const STEPS: StepDef[] = [
  {
    key: "positions",
    version: "2",
    kind: "check",
    description:
      "Every argument becomes a position when its evidence is grounded in its source as Map grounds it",
    checkVersion: POSITIONS_CHECK,
  },
  {
    key: "framing",
    version: "1",
    kind: "model",
    description: "What the rooms were handed, when full transcripts are at hand",
    promptRef: "dembrane/popcorn/prompts/tensions-handed.md",
    promptVersion: VERSIONS.handed as string,
  },
  {
    key: "collisions",
    version: "2",
    kind: "model",
    description:
      "Which arguments collide with a batch of focal arguments, on which question and how zero-sum",
    promptRef: "dembrane/analysis/prompts/tensions-collisions-v1.md",
    promptVersion: VERSIONS.collisions as string,
  },
  {
    key: "verify",
    version: "2",
    kind: "model",
    description:
      "Verify one candidate pair: one question, opposite answers, both held; name the poles or the reason",
    promptRef: "dembrane/analysis/prompts/tensions-verify-v1.md",
    promptVersion: VERSIONS.verify as string,
  },
  {
    key: "dedupe",
    version: "1",
    kind: "model",
    description: "The same tension, a facet of a kept one, or a new one",
    promptRef: "dembrane/popcorn/tensions.py#DEDUPE_SYSTEM",
    promptVersion: VERSIONS[DEDUPE_PROMPT_NAME] as string,
  },
  {
    key: "support",
    version: "1",
    kind: "model",
    description: "Which proposed arguments support pole A, pole B or neither of one tension",
    promptRef: "dembrane/analysis/prompts/tensions-support-v1.md",
    promptVersion: VERSIONS.support as string,
  },
  {
    key: "write",
    version: "2",
    kind: "model",
    description: "The knot and the question, with the screen and completeness gates and one retry",
    promptRef: "dembrane/analysis/prompts/tensions-write-v1.md",
    promptVersion: VERSIONS.write as string,
  },
  {
    key: "review",
    version: "2",
    kind: "check",
    description:
      "Confirmed pinned arguments on both poles, coverage and rejections, and the gates' flags left",
    checkVersion: REVIEW_CHECK,
  },
  {
    key: "embed",
    version: "1",
    kind: "deterministic",
    description: "Embed each tension's projection in the arguments' configuration",
  },
];

/** One structured judgement on the producers' group, with the provider's token usage. */
export async function generateWithUsage(
  services: ProducerServices,
  o: { systemPrompt: string; userText: string; schema: Json; thinking: boolean },
): Promise<[Json, Record<string, number>]> {
  const response = await services.complete({
    system: o.systemPrompt,
    user: o.userText,
    temperature: 0,
    maxTokens: ANALYSIS_MAX_TOKENS,
    jsonSchema: o.schema,
    ...(o.thinking ? {} : { thinkingBudget: 0 }),
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });
  try {
    return [jsonFromText(response.text), { ...response.usage }];
  } catch {
    throw new AnswerDidNotParse("model answer did not parse");
  }
}

const sha = (text: string) => sha256Hex(text);

function stageOf(schema: Json): string {
  for (const [known, stage] of STAGE_BY_SCHEMA) if (schema === known) return stage;
  throw new RecipeFailed(
    "The tensions pipeline asked for a judgement this recipe does not declare.",
  );
}

async function resolveInputs(request: InputRequest): Promise<Json> {
  const services = producerServices(request.services);
  const transcripts = await services.transcripts(request.projectId);
  return {
    sources: transcripts.map((t) => ({ conversationId: t.id, textHash: textHash(t) })),
    prompts: promptVersions(),
    // No host note on voice reaches this recipe yet; declared so one becomes an input the day it does.
    hostNote: "",
  };
}

function argument(r: ObjectRevision, memberIds: readonly string[] = []): ArgumentRevision {
  return {
    revisionId: r.id,
    objectId: r.objectId,
    type: r.type === "deduplicated_argument" ? "deduplicated_argument" : "argument",
    statement: String(r.payload.statement),
    epistemicKind: String(r.payload.epistemicKind),
    valence: (r.payload.valence as string | undefined) ?? null,
    evidence: revisionQuotes(r).map((ref: SourceRef) => ({
      conversationId: ref.conversationId,
      quote: ref.quote ?? "",
      location: ref.location ?? null,
    })),
    memberRevisionIds: [...memberIds],
  };
}

const written = (t: Tension) => [t.pole_a, t.pole_b, t.knot, t.to_resolve].every((x) => x.trim());

/** A tension's identity: the argument objects holding each pole, reworded or not. */
export function lineageKey(t: Tension): string {
  const a = sortedStrings(new Set(t.supporters_a.map((x) => x.object_id))).join("\x1f");
  const b = sortedStrings(new Set(t.supporters_b.map((x) => x.object_id))).join("\x1f");
  return `poles:${sha(`${a}\x1e${b}`).slice(0, 40)}`;
}

const location = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;

async function execute(ctx: RecipeContext): Promise<void> {
  const services = producerServices(ctx.services);
  const deployment = liveModelDeployment(ctx);
  const inputSet = String(ctx.parameters.input_set);
  const expectedType = INPUT_TYPES[inputSet];
  const pinned = ctx.dependencies.get("arguments");
  if (!pinned) throw new RecipeFailed("A recipe this run depends on has no ready output.");
  const revisions = (await ctx.inputRevisions("arguments")).sort((a, b) =>
    compareLists(argumentOrder(a), argumentOrder(b)),
  );
  if (revisions.some((r) => r.type !== expectedType))
    throw new RecipeFailed("The pinned arguments are not the argument set this run reads.");

  // Deduplicated arguments carry their members through `derived_from`.
  const memberIdsOf = new Map<string, string[]>();
  let memberRevisions = new Map<string, ObjectRevision>();
  if (expectedType === "deduplicated_argument") {
    const pinnedIds = new Set(revisions.map((r) => r.id));
    for (const relation of (pinned.manifest.relations as Json[] | undefined) ?? [])
      if (relation.type === "derived_from" && pinnedIds.has(String(relation.from))) {
        const list = memberIdsOf.get(String(relation.from)) ?? [];
        list.push(String(relation.to));
        memberIdsOf.set(String(relation.from), list);
      }
    const wanted = sortedStrings(new Set([...memberIdsOf.values()].flat()));
    memberRevisions = await ctx.store.getRevisions(ctx.projectId, wanted);
    const orderOf = (id: string) => {
      const m = memberRevisions.get(id);
      return m ? argumentOrder(m) : ["", "", "", id];
    };
    for (const [owner, ids] of memberIdsOf)
      memberIdsOf.set(
        owner,
        [...ids].sort((a, b) => compareLists(orderOf(a), orderOf(b))),
      );
  }
  const args = revisions.map((r) => argument(r, memberIdsOf.get(r.id) ?? []));
  const members = [...memberRevisions.keys()]
    .sort((a, b) =>
      compareLists(
        argumentOrder(memberRevisions.get(a) as ObjectRevision),
        argumentOrder(memberRevisions.get(b) as ObjectRevision),
      ),
    )
    .map((id) => argument(memberRevisions.get(id) as ObjectRevision));

  // The embedding configuration the tensions share with their arguments.
  const configKeys = sortedStrings(
    new Set(
      revisions
        .filter((r) => r.embeddingRefs?.configKey)
        .map((r) => String(r.embeddingRefs?.configKey)),
    ),
  );
  if (configKeys.length > 1)
    throw new RecipeFailed(
      "The pinned arguments were embedded in more than one configuration. Refresh the arguments.",
    );
  const configKey = configKeys[0] ?? null;
  const embeddingModels = new Set(
    revisions.filter((r) => r.embeddingRefs?.model).map((r) => String(r.embeddingRefs?.model)),
  );

  // Source passages: the full transcripts of the conversations the evidence names.
  const transcripts = await loadPinnedTranscripts(services, ctx.projectId, [
    ...((ctx.inputManifest.sources as Json[] | undefined) ?? []),
  ]);
  const labels = new Map(transcripts.map((t, i) => [t.id, `Conversation ${i + 1}`]));
  const namedConversations = new Set(
    [...args, ...members].flatMap((a) => a.evidence.map((e) => e.conversationId)),
  );
  const passages: SourcePassages[] = transcripts
    .filter((t) => namedConversations.has(t.id))
    .map((t) => ({ conversationId: t.id, label: labels.get(t.id) as string, transcript: t.text }));
  const textHashes = new Map(transcripts.map((t) => [t.id, textHash(t)]));
  const sourceInputs = passages.map((p) => ({
    conversationId: p.conversationId,
    textHash: textHashes.get(p.conversationId),
  }));

  // 0. positions, recorded as a check before the pipeline reads them again
  const [positions, coverage] = positionsFromArguments(args, passages, members);
  const positionsDoc = {
    positions: positions.map((p) => ({
      revisionId: p.revision_id,
      conversations: p.tables,
      quotes: (p.evidence as unknown[]).length,
    })),
    coverage,
  };
  await ctx.step(
    "positions",
    async () =>
      stepResult({
        output: positionsDoc,
        validation: [
          {
            check: "evidence-grounded",
            status: "passed",
            version: POSITIONS_CHECK,
            evidence: {
              arguments: args.length,
              positions: positions.length,
              withoutEvidence: coverage.without_evidence,
              withoutSource: coverage.without_source,
              evidenceNotFound: coverage.evidence_not_found,
              membersMissing: coverage.members_missing,
            },
          },
        ],
      }),
    {
      inputs: {
        check: POSITIONS_CHECK,
        inputSet,
        revisionIds: args.map((a) => a.revisionId),
        memberRevisionIds: members.map((m) => m.revisionId),
        sources: sourceInputs,
      },
    },
  );

  // 1 to 6: every judgement is a model step of its stage, keyed by its exact call and by
  // what the call is about, so a judgement that never read an argument is not asked again
  // when that argument changes.
  const locks = new Map<string, Promise<unknown>>();
  const generate = async (o: {
    systemPrompt: string;
    userText: string;
    schema: Json;
    thinking: boolean;
  }) => {
    const stage = stageOf(o.schema);
    const call = {
      system: sha(o.systemPrompt),
      user: sha(o.userText),
      schema: contentHash(o.schema),
      thinking: o.thinking,
    };
    const digest = contentHash(call);
    const named = namedInputs();
    const previous = locks.get(digest) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() =>
        ctx.step<Json>(
          stage,
          async () => {
            const [answer, usage] = await generateWithUsage(services, o);
            const tokens = Object.fromEntries(
              Object.entries(usage)
                .filter(([k]) => TOKEN_KEYS.includes(k))
                .map(([k, v]) => [k, Math.trunc(v)]),
            );
            return stepResult({ output: answer, usage: tokens, modelCalls: 1 });
          },
          { instance: digest.slice(0, 40), inputs: { ...call, ...named, model: deployment } },
        ),
      );
    locks.set(digest, run);
    return { ...(await run) };
  };

  await ctx.progress("finding tensions", { force: true, counts: { positions: positions.length } });
  const outcome = await runTensions(args, passages, {
    generate,
    retryable: (err) => err instanceof AnswerDidNotParse,
    members,
    inputSet: expectedType === "deduplicated_argument" ? "deduplicated" : "raw",
    concurrency: ctx.recipe.modelConcurrency ?? 8,
  });

  // review: both poles, pinned arguments only, what the run covered and the gates' flags
  const pinnedIds = new Set(args.map((a) => a.revisionId));
  const problems: string[] = [];
  const unwritten: string[] = [];
  for (const t of outcome.tensions) {
    const poleA = new Set(t.supporters_a.map((x) => x.revision_id));
    const poleB = new Set(t.supporters_b.map((x) => x.revision_id));
    if (!poleA.size || !poleB.size) problems.push(`${t.key}: a pole has no supporting argument`);
    if ([...poleA].some((x) => poleB.has(x)))
      problems.push(`${t.key}: an argument supports both poles`);
    if ([...poleA, ...poleB].some((x) => !pinnedIds.has(x)))
      problems.push(`${t.key}: a supporter is not a pinned argument`);
    if (poleA.size > MAX_SUPPORTERS_PER_POLE || poleB.size > MAX_SUPPORTERS_PER_POLE)
      problems.push(`${t.key}: more supporters on a pole than the cap`);
    if (!written(t)) unwritten.push(t.key);
  }
  const inTensions = new Map<string, number>();
  for (const t of outcome.tensions)
    for (const x of [...t.supporters_a, ...t.supporters_b])
      inTensions.set(x.revision_id, (inTensions.get(x.revision_id) ?? 0) + 1);
  const flagged: Record<string, string[]> = {};
  for (const t of outcome.tensions)
    if (t.screen_flags.length && !unwritten.includes(t.key)) flagged[t.key] = t.screen_flags;
  const covered = outcome.coverage;
  const summary = {
    status: outcome.status,
    inputSet,
    counts: outcome.counts,
    coverage: covered,
    suggestion: outcome.suggestion,
    gateFlags: outcome.gate_flags,
    promptVersions: outcome.prompt_versions,
    callsByStage: outcome.usage.calls_by_stage ?? null,
    unwritten,
    tensions: outcome.tensions.map((t) => ({
      key: t.key,
      question: t.question,
      supportersA: t.supporters_a.map((x) => ({ revisionId: x.revision_id, strength: x.strength })),
      supportersB: t.supporters_b.map((x) => ({ revisionId: x.revision_id, strength: x.strength })),
      flags: t.screen_flags,
    })),
    relations: outcome.relations.map((r) => ({
      type: r.type,
      from: r.from_revision_id,
      tension: r.to_tension,
      check: r.check,
    })),
  };
  const flaggedCount = Object.keys(flagged).length;
  await ctx.step(
    "review",
    async () =>
      stepResult({
        output: summary,
        validation: [
          {
            check: "both-poles-supported",
            status: problems.length ? "failed" : "passed",
            version: REVIEW_CHECK,
            evidence: {
              tensions: outcome.tensions.length - unwritten.length,
              relations: outcome.relations.length,
              problems,
              unwritten,
            },
          },
          {
            check: "support-confirmed",
            status: "passed",
            version: REVIEW_CHECK,
            evidence: {
              maxPerPole: MAX_SUPPORTERS_PER_POLE,
              minStrength: MIN_SUPPORT_STRENGTH,
              rejected: covered.support_rejected,
              capped: covered.support_capped,
              unsupportedTensions: covered.unsupported,
              argumentsInSeveralTensions: Object.fromEntries(
                sortedStrings(inTensions.keys())
                  .filter((id) => (inTensions.get(id) ?? 0) > 1)
                  .map((id) => [id, inTensions.get(id)]),
              ),
            },
          },
          {
            check: "tension-coverage",
            status: "passed",
            version: REVIEW_CHECK,
            evidence: {
              status: outcome.status,
              suggestion: outcome.suggestion,
              inputSet,
              arguments: covered.arguments,
              positions: covered.positions,
              conversationsWithEvidence: covered.conversations_with_evidence,
              withoutEvidence: covered.without_evidence.length,
              withoutSource: covered.without_source.length,
              evidenceNotFound: covered.evidence_not_found.length,
              trimmed: covered.trimmed.length,
              bothPolesSkipped: covered.both_poles_skipped.length,
              rejectedPairs: covered.rejected_pairs,
              framing: covered.framing,
              thin: covered.thin,
            },
            message: covered.note,
          },
          {
            check: "screen-gate",
            status: flaggedCount ? "needs_review" : "passed",
            version: REVIEW_CHECK,
            evidence: { flagsLeft: flagged },
            message: flaggedCount
              ? `${flaggedCount} tension(s) still break the screen or completeness gate after the retry.`
              : null,
          },
        ],
      }),
    {
      inputs: {
        check: REVIEW_CHECK,
        revisionIds: sortedStrings(pinnedIds),
        result: artifactHash(summary),
      },
    },
  );
  if (problems.length) return;

  const emittable = outcome.tensions.filter((t) => !unwritten.includes(t.key));
  const payloads = new Map<string, Json>(
    emittable.map((t) => {
      const onA = new Set(t.supporters_a.flatMap((x) => x.quote_ids));
      return [
        t.key,
        {
          poleA: t.pole_a,
          poleB: t.pole_b,
          knot: t.knot,
          toResolve: t.to_resolve,
          quotes: t.quotes.map((q) => ({
            text: q.text,
            conversationId: q.conversation_id,
            location: location(q.location),
            pole: onA.has(q.id) ? "A" : "B",
          })),
        },
      ];
    }),
  );

  // embeddings of each tension's projection, in the arguments' configuration
  await ctx.progress("embedding", { force: true });
  const projection = getObjectType("tension").map;
  if (!projection) throw new Error("tension has no map projection");
  const texts = new Map<string, string>();
  for (const p of payloads.values())
    texts.set(inputHash(projection.embeddingText(p)), projection.embeddingText(p));
  const hits = ctx.metric("cacheHits");
  const resumed = ctx.metric("stepsResumed");
  const embedded = await ctx.step<Json>(
    "embed",
    async () => {
      const stored =
        texts.size && configKey
          ? await ctx.store.loadEmbeddings(ctx.projectId, configKey, sortedStrings(texts.keys()))
          : new Map();
      const ids: Record<string, string> = {};
      for (const [hashed, [id]] of stored) ids[hashed] = id;
      const missing = sortedStrings(texts.keys()).filter((h) => !stored.has(h));
      let key: string | null = configKey;
      let model: string | null =
        embeddingModels.size === 1 ? ([...embeddingModels][0] as string) : null;
      let computed = 0;
      if (missing.length) {
        const identity = await services.probe();
        if (configKey !== null && identityKey(identity) !== configKey)
          throw new RecipeFailed(
            "The embedding deployment changed since the arguments were embedded. Refresh the arguments first.",
          );
        const service = new EmbeddingService(ctx.store, identity, services.embed);
        const batch = await service.ensure(
          ctx.projectId,
          missing.map((h) => texts.get(h) as string),
        );
        for (const [h, id] of batch.ids) ids[h] = id;
        key = service.key;
        model = identity.model;
        computed = batch.computed;
      }
      const unique = [...new Set(Object.values(ids))];
      const durable = await ctx.store.vectorsByIds(ctx.projectId, sortedStrings(unique));
      if (durable.size !== unique.length)
        throw new RecipeFailed("Saving the tensions' vectors failed.");
      return stepResult({ output: { ids, configKey: key, model, reused: stored.size, computed } });
    },
    {
      inputs: {
        embeddingConfigKey: configKey,
        projectionVersion: projection.projectionVersion,
        inputHashes: sortedStrings(texts.keys()),
      },
    },
  );
  if (fresh(ctx, hits, resumed)) {
    ctx.count("embeddingsReused", Number(embedded.reused));
    ctx.count("embeddingsComputed", Number(embedded.computed));
  }

  // objects and relations, against the exact pinned revisions
  await ctx.progress("emitting", { force: true });
  const byRevision = new Map(revisions.map((r) => [r.id, r]));
  const byQuote = new Map(outcome.quotes.map((q) => [q.id, q]));
  const seen = new Map<string, number>();
  const ids = embedded.ids as Record<string, string>;
  for (const t of emittable) {
    const base = lineageKey(t);
    seen.set(base, (seen.get(base) ?? 0) + 1);
    const key = seen.get(base) === 1 ? base : `${base}:${seen.get(base)}`;
    const supporters = [...t.supporters_a, ...t.supporters_b];
    const payload = payloads.get(t.key) as Json;
    const hashed = inputHash(projection.embeddingText(payload));
    const revision = await ctx.emit("tension", key, payload, {
      sourceRefs: t.quotes.map((q) => ({
        conversationId: q.conversation_id,
        sourceFingerprint: textHashes.get(q.conversation_id) ?? null,
        quote: q.text,
        location: location(q.location),
      })),
      inputRevisionIds: supporters.map((x) => x.revision_id),
      embeddingRefs: {
        ...refJson({
          embeddingId: ids[hashed] as string,
          inputHash: hashed,
          configKey: String(embedded.configKey),
          projectionVersion: projection.projectionVersion,
        }),
        ...(embedded.model ? { model: embedded.model } : {}),
      },
      extra: { inputSet, question: t.question },
    });
    for (const relation of outcome.relations) {
      if (relation.to_tension !== t.key) continue;
      const supporter = supporters.find((x) => x.revision_id === relation.from_revision_id);
      const quotes = (supporter?.quote_ids ?? [])
        .filter((q) => byQuote.has(q))
        .map((q) => byQuote.get(q) as (typeof outcome.quotes)[number]);
      await ctx.relate(
        relation.type,
        byRevision.get(relation.from_revision_id) as ObjectRevision,
        revision,
        {
          basis: relation.basis,
          attributes: {
            rationale: String(relation.check.why || "") || null,
            quotes: quotes.map((q) => ({
              text: q.text,
              conversationId: q.conversation_id,
              location: location(q.location),
            })),
          },
          sourceRefs: quotes.map((q) => ({
            conversationId: q.conversation_id,
            sourceFingerprint: textHashes.get(q.conversation_id) ?? null,
            quote: q.text,
          })),
        },
      );
      ctx.count(relation.type);
    }
    ctx.count("tensions");
    if (t.screen_flags.length) ctx.count("tensionsFlagged");
  }
}

export const RECIPE: Recipe = {
  id: RECIPE_ID,
  version: RECIPE_VERSION,
  name: "Tensions",
  purpose:
    "Find the tensions between saved arguments: two poles answering one question in opposite directions, the knot between them and the question to resolve, each pole linked to the exact arguments confirmed to hold it.",
  inputTypes: ["argument", "deduplicated_argument"],
  steps: STEPS,
  outputTypes: ["tension"],
  execute,
  dependencies: (_scopeKey, parameters) => [
    { recipeId: String(parameters.input_set), scopeKey: "project", name: "arguments" },
  ],
  resolveInputs,
  validationRules: [
    "reads one argument set, raw or deduplicated, never both",
    "a tension's poles answer one question in opposite directions; a rejected pair keeps its reason",
    "every pole is held by one to three pinned arguments confirmed by the support check, whose evidence is grounded in its source",
    "an argument is confirmed separately for every tension and never holds both poles of one",
    "a verifier never supplies a side or a quote",
    "a knot or question left broken after the retry puts the run up for review",
    "too little evidence is a valid result that suggests refreshing the arguments",
  ],
  identityPolicy: {
    description:
      "A tension keeps its identity while the same argument objects hold each of its poles.",
  },
  embeddingProjections: ["tension"],
  parameters: {
    name: "TensionsParameters",
    fields: [required("input_set", s.lit("arguments", "deduplicated_arguments"))],
  },
  scopeKeyPattern: /^project$/,
  modelConfig: modelDeployment,
  modelConcurrency: 8,
  // Every step names what it reads of these, so an unchanged judgement is not asked again
  // when an argument it never read changes.
  partitionedInputs: ["sources", "revisionIds", "dependencies.arguments"],
};
