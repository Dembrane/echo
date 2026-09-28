import {
  AnalysisStoreError,
  AnalysisValidationError,
  type Json,
  type ObjectRevision,
  type SourceRef,
} from "../contracts";
import { EmbeddingService, inputHash, refJson } from "../embeddings";
import { type RecipeContext, RecipeFailed, RunStopped, stepResult, taskGroup } from "../executor";
import { CanonicalizationError, contentHash, sha256Hex } from "../hashing";
import {
  type Candidate,
  claimKey,
  mergeConversationCandidates,
  pyFind,
  shapeExtraction,
  sourceFingerprint,
  type Transcript,
  textHash,
  transcriptWindows,
  WINDOW_CHARS,
  WINDOW_OVERLAP_CHARS,
} from "../maprecipe";
import type { InputRequest, Recipe, StepDef } from "../registry";
import { normKey } from "../text";
import { getObjectType } from "../types";
import { EXTRACTION_PROMPT, extractArguments } from "./model";
import { modelDeployment, type ProducerServices, producerServices } from "./services";

/**
 * Arguments: Map's grounded transcript extraction as a recipe. Scope `project`; inputs are
 * the project's transcripts pinned by their text hashes. load (check the pinned hashes),
 * extract (model, once per conversation, keyed by its text hash, prompt and model),
 * ground (check quotes verbatim), merge (one candidate per item across windows), embed
 * (each statement's projection, reusing stored vectors). Every output is an `argument`
 * whose lineage key is its conversation and item key.
 */

export const RECIPE_ID = "arguments";
export const RECIPE_VERSION = "arguments-v1";
export const EXTRACTION_CONCURRENCY = 6;
export const GROUND_CHECK = "ground-quote-v1";
/** A quote's location: its offset in the whitespace-collapsed, case-folded transcript. */
export const LOCATION_BASIS = "collapsed-casefold-v1";

const STEPS: StepDef[] = [
  {
    key: "load",
    version: "1",
    kind: "deterministic",
    description: "Read the transcripts and check them against the pinned text hashes",
  },
  {
    key: "extract",
    version: "1",
    kind: "model",
    description: "Extract arguments and claims from one conversation, window by window",
    promptRef: `dembrane/map/prompts/${EXTRACTION_PROMPT}.md`,
    promptVersion: EXTRACTION_PROMPT,
  },
  {
    key: "ground",
    version: "1",
    kind: "check",
    description:
      "Keep items with a known kind and valence and a quote found verbatim in their transcript",
    checkVersion: GROUND_CHECK,
  },
  {
    key: "merge",
    version: "1",
    kind: "deterministic",
    description: "One candidate per source item across overlapping windows",
  },
  {
    key: "embed",
    version: "1",
    kind: "deterministic",
    description: "Embed each statement's projection, reusing stored vectors",
  },
];

/**
 * A step artifact's fingerprint for the steps that consume it. A model answer can hold what
 * canonical JSON refuses, so those fall back to sorted JSON.
 */
export function artifactHash(value: unknown): string {
  try {
    return contentHash(value);
  } catch (err) {
    if (!(err instanceof CanonicalizationError)) throw err;
    return `json:${sha256Hex(JSON.stringify(sortKeys(value)))}`;
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Json)
        .sort()
        .map((k) => [k, sortKeys((v as Json)[k])]),
    );
  return v;
}

/** A stable order for pinned argument revisions: first evidence's time and id, then statement. */
export function argumentOrder(r: ObjectRevision): string[] {
  const evidence = ((r.payload.evidence as Json[] | undefined) ?? [{}])[0] ?? {};
  return [
    String(evidence.createdAt || ""),
    String(evidence.conversationId || ""),
    String(r.payload.statement || ""),
    r.objectId,
  ];
}

/** A revision's checked evidence: its source references, or for an import its payload's quotes. */
export function revisionQuotes(r: ObjectRevision): SourceRef[] {
  const refs = (r.provenance.sourceRefs ?? []).filter((ref) => ref.quote?.trim());
  if (refs.length) return refs;
  return ((r.payload.evidence as Json[] | undefined) ?? []).flatMap((item) =>
    ((item.quotes as unknown[] | undefined) ?? [])
      .filter((q) => String(q).trim())
      .map((q) => ({ conversationId: String(item.conversationId), quote: String(q) })),
  );
}

export const liveModelDeployment = (ctx: RecipeContext): Json => ({
  ...producerServices(ctx.services).modelDeployment(),
});

/** Whether the step just awaited computed, rather than reusing an artifact. */
export const fresh = (ctx: RecipeContext, hitsBefore: number, resumedBefore: number) =>
  ctx.metric("cacheHits") === hitsBefore && ctx.metric("stepsResumed") === resumedBefore;

const source = (t: Transcript): Json => ({
  conversationId: t.id,
  textHash: textHash(t),
  label: t.label,
  createdAt: t.createdAt,
});

export async function resolveInputs(request: InputRequest): Promise<Json> {
  const services = producerServices(request.services);
  const transcripts = await services.transcripts(request.projectId);
  return {
    sources: transcripts.map(source),
    sourceFingerprint: sourceFingerprint(transcripts),
    embedding: { ...services.embeddingSettings() },
  };
}

/** The pinned conversations' transcripts in pinned order; a moved one fails the run. */
export async function loadPinnedTranscripts(
  services: ProducerServices,
  projectId: string,
  sources: readonly Json[],
): Promise<Transcript[]> {
  const byId = new Map((await services.transcripts(projectId)).map((t) => [t.id, t]));
  const moved = sources.filter((s) => {
    const t = byId.get(String(s.conversationId));
    return !t || textHash(t) !== s.textHash;
  });
  if (moved.length)
    throw new RecipeFailed(
      `${moved.length} conversation(s) changed after this run pinned its inputs. Request it again.`,
    );
  return sources.map((s) => byId.get(String(s.conversationId)) as Transcript);
}

/** One extraction call per window, in order; each raw answer with its usage. */
export async function readConversation(
  services: ProducerServices,
  transcript: Transcript,
): Promise<[Json, Record<string, number>][]> {
  const windows = transcriptWindows(transcript.text);
  const answers: [Json, Record<string, number>][] = [];
  for (const [index, window] of windows.entries())
    answers.push(
      await extractArguments(services, {
        conversationId: transcript.id,
        window,
        windowIndex: index,
        windowCount: windows.length,
      }),
    );
  return answers;
}

function location(transcriptKey: string, quote: string): Json | null {
  const found = pyFind(transcriptKey, normKey(quote));
  return found >= 0 ? { offset: found, basis: LOCATION_BASIS } : null;
}

/** A failure of one conversation's reading, as opposed to the run stopping or storage failing. */
const conversationFailure = (err: unknown) =>
  !(
    err instanceof RunStopped ||
    err instanceof AnalysisStoreError ||
    err instanceof AnalysisValidationError
  );

export async function execute(ctx: RecipeContext): Promise<void> {
  const services = producerServices(ctx.services);
  const sources = [...((ctx.inputManifest.sources as Json[] | undefined) ?? [])];
  const embeddingConfig = { ...((ctx.inputManifest.embedding as Json | undefined) ?? {}) };
  const deployment = liveModelDeployment(ctx);

  await ctx.progress("loading", { force: true });
  const transcripts = await loadPinnedTranscripts(services, ctx.projectId, sources);
  const fingerprints = transcripts.map((t) => ({ conversationId: t.id, textHash: textHash(t) }));
  await ctx.step(
    "load",
    async () =>
      stepResult({
        output: { conversations: fingerprints },
        validation: [
          {
            check: "sources-match-pinned",
            status: "passed",
            evidence: { conversations: transcripts.length },
          },
        ],
      }),
    { inputs: { sources: fingerprints } },
  );

  const answers = new Map<string, Json[]>();
  const extractHashes = new Map<string, string>();
  const failed = new Map<string, string>();
  const extractOne = async (transcript: Transcript) => {
    let output: Json;
    try {
      output = await ctx.step<Json>(
        "extract",
        async () => {
          const read = await readConversation(services, transcript);
          const usage: Record<string, number> = {};
          for (const [, used] of read)
            for (const [k, v] of Object.entries(used)) usage[k] = (usage[k] ?? 0) + v;
          return stepResult({
            output: { windows: read.map(([raw]) => raw) },
            usage,
            modelCalls: read.length,
          });
        },
        {
          instance: transcript.id,
          inputs: {
            conversationId: transcript.id,
            textHash: textHash(transcript),
            prompt: EXTRACTION_PROMPT,
            windowChars: WINDOW_CHARS,
            windowOverlapChars: WINDOW_OVERLAP_CHARS,
            model: deployment,
          },
        },
      );
    } catch (err) {
      if (!conversationFailure(err)) throw err;
      failed.set(transcript.id, (err as Error)?.constructor?.name ?? "Error");
      ctx.deps.logger?.warn(
        {
          run_id: ctx.run.id,
          conversation_id: transcript.id,
          error: (err as Error)?.constructor?.name,
        },
        "arguments run: conversation failed",
      );
      return;
    }
    answers.set(transcript.id, [...(output.windows as Json[])]);
    extractHashes.set(transcript.id, artifactHash(output));
    await ctx.progress("extracting", {
      counts: {
        conversations_total: transcripts.length,
        conversations_done: answers.size,
        conversations_failed: failed.size,
      },
    });
  };
  await taskGroup(transcripts.map((t) => () => extractOne(t)));
  if (failed.size)
    throw new RecipeFailed(`Reading ${failed.size} of ${transcripts.length} conversations failed.`);

  const groundInputs = {
    check: GROUND_CHECK,
    conversations: transcripts.map((t) => ({
      conversationId: t.id,
      textHash: textHash(t),
      extraction: extractHashes.get(t.id),
    })),
  };
  const grounded = await ctx.step<Json>(
    "ground",
    async () => {
      const per: Json = {};
      let kept = 0;
      let dropped = 0;
      for (const t of transcripts) {
        const windows: Candidate[][] = [];
        let lostHere = 0;
        for (const [index, raw] of (answers.get(t.id) ?? []).entries()) {
          const [candidates, lost] = shapeExtraction(raw, t, index);
          windows.push(candidates);
          lostHere += lost;
          kept += candidates.length;
        }
        per[t.id] = { windows, dropped: lostHere };
        dropped += lostHere;
      }
      return stepResult({
        output: { conversations: per },
        validation: [
          {
            check: "quotes-verbatim",
            status: "passed",
            version: GROUND_CHECK,
            evidence: {
              conversations: transcripts.length,
              kept,
              dropped,
              droppedByConversation: Object.fromEntries(
                Object.entries(per).map(([cid, entry]) => [cid, (entry as Json).dropped]),
              ),
            },
          },
        ],
      });
    },
    { inputs: groundInputs },
  );
  const groundHash = artifactHash(grounded);
  const groundedConversations = grounded.conversations as Record<
    string,
    { windows: Candidate[][]; dropped: number }
  >;

  const merged = (
    await ctx.step<Json>(
      "merge",
      async () =>
        stepResult({
          output: {
            conversations: Object.fromEntries(
              transcripts.map((t) => [
                t.id,
                mergeConversationCandidates(groundedConversations[t.id]?.windows ?? []),
              ]),
            ),
          },
        }),
      { inputs: { ground: groundHash } },
    )
  ).conversations as Record<string, Candidate[]>;
  await ctx.progress("embedding", { force: true });

  const projection = getObjectType("argument").map;
  if (!projection) throw new Error("argument has no map projection");
  const texts = new Map<string, string>();
  for (const t of transcripts)
    for (const candidate of merged[t.id] ?? []) {
      const text = projection.embeddingText({ statement: candidate.statement });
      texts.set(inputHash(text), text);
    }
  const hits = ctx.metric("cacheHits");
  const resumed = ctx.metric("stepsResumed");
  const embedded = await ctx.step<Json>(
    "embed",
    async () => {
      if (!texts.size)
        return stepResult({
          output: { ids: {}, configKey: null, model: null, reused: 0, computed: 0 },
        });
      const identity = await services.probe();
      const service = new EmbeddingService(ctx.store, identity, services.embed);
      const batch = await service.ensure(ctx.projectId, texts.values());
      await service.verifyDurable(ctx.projectId, batch.ids.values());
      return stepResult({
        output: {
          ids: Object.fromEntries(batch.ids),
          configKey: service.key,
          model: identity.model,
          dims: identity.dims,
          reused: batch.reused,
          computed: batch.computed,
        },
      });
    },
    {
      inputs: {
        embedding: embeddingConfig,
        projectionVersion: projection.projectionVersion,
        inputHashes: [...texts.keys()].sort(),
      },
    },
  );
  if (fresh(ctx, hits, resumed)) {
    ctx.count("embeddingsReused", Number(embedded.reused));
    ctx.count("embeddingsComputed", Number(embedded.computed));
  }

  await ctx.progress("emitting", { force: true });
  const ids = embedded.ids as Record<string, string>;
  for (const t of transcripts) {
    const transcriptKey = normKey(t.text);
    for (const candidate of merged[t.id] ?? []) {
      const statement = candidate.statement;
      const hashed = inputHash(projection.embeddingText({ statement }));
      const extra: Json = {};
      if (candidate.kind === "claim") extra.claimKey = claimKey(statement, candidate.quotes);
      await ctx.emit(
        "argument",
        `${t.id}:${candidate.id}`,
        {
          statement,
          epistemicKind: candidate.kind,
          valence: candidate.valence,
          evidence: [
            {
              conversationId: t.id,
              label: t.label,
              createdAt: t.createdAt,
              quotes: [...candidate.quotes],
            },
          ],
        },
        {
          sourceRefs: candidate.quotes.map((quote) => ({
            conversationId: t.id,
            sourceFingerprint: textHash(t),
            quote,
            location: location(transcriptKey, quote),
          })),
          embeddingRefs: {
            ...refJson({
              embeddingId: ids[hashed] as string,
              inputHash: hashed,
              configKey: String(embedded.configKey),
              projectionVersion: projection.projectionVersion,
            }),
            model: embedded.model,
          },
          extra,
        },
      );
    }
  }
  ctx.count("conversations", transcripts.length);
  ctx.count(
    "candidates",
    transcripts.reduce((n, t) => n + (merged[t.id]?.length ?? 0), 0),
  );
  ctx.count(
    "droppedUngrounded",
    transcripts.reduce((n, t) => n + Number(groundedConversations[t.id]?.dropped ?? 0), 0),
  );
}

export const RECIPE: Recipe = {
  id: RECIPE_ID,
  version: RECIPE_VERSION,
  name: "Arguments",
  purpose:
    "Extract complete, source-grounded arguments and claims from every conversation in the project, keeping distinct arguments separate.",
  inputTypes: [],
  steps: STEPS,
  outputTypes: ["argument"],
  execute,
  resolveInputs,
  validationRules: [
    "every argument has a statement, a kind and a valence",
    "every argument has at least one quote found verbatim in its conversation",
    "every statement's vector is durable before publication",
  ],
  identityPolicy: {
    description:
      "An argument keeps its identity while its conversation and extracted item (kind and normalised statement) stay the same; a reworded statement is a new object.",
  },
  embeddingProjections: ["argument"],
  scopeKeyPattern: /^project$/,
  modelConfig: modelDeployment,
  modelConcurrency: EXTRACTION_CONCURRENCY,
  // Each step names the conversation (text hash) or embedding configuration it read.
  partitionedInputs: ["sources", "sourceFingerprint", "embedding"],
};
