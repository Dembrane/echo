import type { Json, ObjectRevision, SourceRef } from "../contracts";
import { EmbeddingService, inputHash, refJson } from "../embeddings";
import { type RecipeContext, RecipeFailed, stepResult } from "../executor";
import { pyFind, sourceFingerprint, textHash } from "../maprecipe";
import stakeholdersPrompt from "../prompts/stakeholders-v0.9.md" with { type: "text" };
import type { InputRequest, Recipe, StepDef } from "../registry";
import { normKey, sha256Hex } from "../text";
import { getObjectType } from "../types";
import {
  artifactHash,
  fresh,
  LOCATION_BASIS,
  liveModelDeployment,
  loadPinnedTranscripts,
} from "./arguments";
import {
  allocateChars,
  type BookQuote,
  buildCorpus,
  cpLength,
  cpSlice,
  generateWithUsage,
  islandFlags,
  MAX_ANALYSIS_CHARS,
  nameFlags,
  norm,
  QuoteBook,
  STAKEHOLDERS_PROMPT,
  STAKEHOLDERS_SCHEMA,
  shapeStakeholders,
  TOKEN_KEYS,
  transcriptMessage,
} from "./popcorn-shared";
import { modelDeployment, producerServices } from "./services";

/**
 * Stakeholders: who has something at stake, and how they stand to each other. Scope
 * `project`: one grounded call over every transcript inside one shared character budget,
 * its gates (one group per name, one connected map) with one retry carrying the flags,
 * then each group's projection embedded. Every quote is checked verbatim against the
 * transcript it is credited to; a quote the session does not hold is dropped with the
 * aspect resting on it. No relation to an argument or a tension is invented.
 */

export const RECIPE_ID = "stakeholders";
export const RECIPE_VERSION = "stakeholders-v1";
export const GATES_CHECK = "stakeholder-gates-v1";
export const STAKEHOLDERS_PROMPT_TEXT: string = stakeholdersPrompt;
// How a failed answer goes back to the model, word for word as the live tick sends it.
const FEEDBACK_HEADING = "## Your previous answer failed these checks";
const FEEDBACK_CLOSE = "\nFix every one of them and return the complete output again.";

const STEPS: StepDef[] = [
  {
    key: "corpus",
    version: "1",
    kind: "deterministic",
    description:
      "Every transcript inside one shared character budget, with what each conversation kept",
  },
  {
    key: "stakeholders",
    version: "1",
    kind: "model",
    description:
      "The groups with something at stake and the relations between them, over the whole session",
    promptRef: `dembrane/popcorn/prompts/${STAKEHOLDERS_PROMPT}.md`,
    promptVersion: STAKEHOLDERS_PROMPT,
  },
  {
    key: "gates",
    version: "1",
    kind: "check",
    description: "One group per name and one connected map, with the flags left after the retry",
    checkVersion: GATES_CHECK,
  },
  {
    key: "embed",
    version: "1",
    kind: "deterministic",
    description: "Embed each group's projection, reusing stored vectors",
  },
];

export const feedbackPrompt = (system: string, flags: readonly string[]) =>
  `${system}\n\n${FEEDBACK_HEADING}\n\n${flags.map((f) => `- ${f}\n`).join("")}${FEEDBACK_CLOSE}`;

/** A group's identity: its name as the room said it, normalised; `s1` is only a list position. */
export const lineageKey = (name: string) => `name:${sha256Hex(norm(name)).slice(0, 40)}`;

export async function resolveInputs(request: InputRequest): Promise<Json> {
  const services = producerServices(request.services);
  const transcripts = await services.transcripts(request.projectId);
  return {
    sources: transcripts.map((t) => ({ conversationId: t.id, textHash: textHash(t) })),
    sourceFingerprint: sourceFingerprint(transcripts),
    prompt: STAKEHOLDERS_PROMPT,
    budget: MAX_ANALYSIS_CHARS,
    embedding: { ...services.embeddingSettings() },
  };
}

function location(
  keys: ReadonlyMap<string, string>,
  conversationId: string,
  quote: string,
): Json | null {
  const found = pyFind(keys.get(conversationId) ?? "", normKey(quote));
  return found >= 0 ? { offset: found, basis: LOCATION_BASIS } : null;
}

export function quoteRefs(
  quoteIds: readonly string[],
  bookQuotes: ReadonlyMap<string, BookQuote>,
  keys: ReadonlyMap<string, string>,
): Json[] {
  const refs: Json[] = [];
  for (const id of quoteIds) {
    const quote = bookQuotes.get(id);
    if (!quote) continue;
    refs.push({
      text: quote.text,
      conversationId: quote.transcript,
      location: location(keys, quote.transcript, quote.text),
    });
  }
  return refs;
}

export function sourceRefs(
  quoteIds: readonly string[],
  bookQuotes: ReadonlyMap<string, BookQuote>,
  keys: ReadonlyMap<string, string>,
  hashes: ReadonlyMap<string, string>,
): SourceRef[] {
  return quoteRefs(quoteIds, bookQuotes, keys).map((ref) => ({
    conversationId: String(ref.conversationId),
    sourceFingerprint: hashes.get(String(ref.conversationId)) ?? null,
    quote: String(ref.text),
    location: (ref.location as Json | null) ?? null,
  }));
}

/** The stakeholder payload a slide group becomes, before schema validation. */
export function stakeholderPayload(
  person: Json,
  bookQuotes: ReadonlyMap<string, BookQuote>,
  keys: ReadonlyMap<string, string>,
): Json {
  const evidence = person.evidence as Json;
  const weight = person.weight as Json;
  return {
    name: person.name,
    role: person.role,
    stake: person.stake,
    rung: evidence.rung,
    ...(evidence.invokedBy ? { invokedBy: String(evidence.invokedBy) } : {}),
    weight: { stake: Number(weight.stake), mentions: Number(weight.mentions) },
    quotes: quoteRefs(
      ((person.quoteIds as string[] | undefined) ?? []).map(String),
      bookQuotes,
      keys,
    ),
  };
}

/** The stakeholder_relation attributes a slide relation becomes, before validation. */
export function relationAttributes(
  relation: Json,
  bookQuotes: ReadonlyMap<string, BookQuote>,
  keys: ReadonlyMap<string, string>,
): Json {
  return {
    label: relation.label,
    intensity: Number(relation.intensity),
    sentiment: Number(relation.sentiment),
    unowned: Boolean(relation.unowned),
    detail: relation.detail,
    aspects: ((relation.aspects as Json[] | undefined) ?? []).map((a) => ({
      kind: a.kind,
      note: a.note,
      quotes: quoteRefs(((a.quoteIds as string[] | undefined) ?? []).map(String), bookQuotes, keys),
    })),
  };
}

const passedGates = (evidence: Json, message: string | null = null) => ({
  check: "stakeholder-gates",
  status: "passed" as const,
  version: GATES_CHECK,
  evidence,
  message,
});

export async function execute(ctx: RecipeContext): Promise<void> {
  const services = producerServices(ctx.services);
  const deployment = liveModelDeployment(ctx);
  const sources = [...((ctx.inputManifest.sources as Json[] | undefined) ?? [])];
  const transcripts = await loadPinnedTranscripts(services, ctx.projectId, sources);
  if (!transcripts.length) {
    // A session with nothing said yet is a valid, empty output.
    await ctx.step("corpus", async () => stepResult({ output: { conversations: [], chars: 0 } }), {
      inputs: { sources: [] },
    });
    await ctx.step(
      "gates",
      async () =>
        stepResult({
          output: { flags: [], left: [], retried: false },
          validation: [passedGates({ stakeholders: 0, relations: 0, flags: [], left: [] })],
        }),
      { inputs: { check: GATES_CHECK, answer: null } },
    );
    return;
  }

  await ctx.progress("reading", { force: true });
  const lengths: Record<string, number> = {};
  for (const t of transcripts) lengths[t.id] = cpLength(t.text);
  const quota = allocateChars(lengths, MAX_ANALYSIS_CHARS);
  const texts: Record<string, string> = {};
  for (const t of transcripts) texts[t.id] = cpSlice(t.text, quota[t.id] as number);
  const hashes = new Map(transcripts.map((t) => [t.id, textHash(t)]));
  const keys = new Map(transcripts.map((t) => [t.id, normKey(t.text)]));
  const corpusDoc: Json = {
    conversations: transcripts.map((t) => ({
      conversationId: t.id,
      textHash: textHash(t),
      chars: lengths[t.id],
      read: quota[t.id],
    })),
    chars: Object.values(quota).reduce((a, b) => a + b, 0),
    clipped: Object.keys(lengths)
      .filter((tid) => (quota[tid] as number) < (lengths[tid] as number))
      .sort(),
  };
  await ctx.step("corpus", async () => stepResult({ output: corpusDoc }), {
    inputs: { sources: corpusDoc.conversations, budget: MAX_ANALYSIS_CHARS },
  });
  const corpus = buildCorpus(Object.entries(texts));
  const system = STAKEHOLDERS_PROMPT_TEXT;
  const userText = transcriptMessage("session", corpus);

  const ask = async (prompt: string, instance: string): Promise<Json> => ({
    ...(await ctx.step<Json>(
      "stakeholders",
      async () => {
        const [answer, usage] = await generateWithUsage(services, {
          systemPrompt: prompt,
          userText,
          schema: STAKEHOLDERS_SCHEMA,
          thinking: true,
        });
        return stepResult({
          output: answer,
          usage: Object.fromEntries(Object.entries(usage).filter(([k]) => TOKEN_KEYS.includes(k))),
          modelCalls: 1,
        });
      },
      {
        instance,
        inputs: { prompt: sha256Hex(prompt), corpus: artifactHash(corpusDoc), model: deployment },
      },
    )),
  });

  // One call, its gates, and one retry carrying the flags.
  await ctx.progress("reading the session", { force: true });
  let raw = await ask(system, "first");
  // A throwaway book keeps a rejected answer's quotes out of the registry published from.
  const probe = shapeStakeholders(raw, new QuoteBook(texts));
  const flags = [...nameFlags(probe), ...islandFlags(probe)];
  if (flags.length) {
    await ctx.progress("asking again", { force: true, counts: { flags: flags.length } });
    raw = await ask(feedbackPrompt(system, flags), "retry");
  }

  const book = new QuoteBook(texts);
  const slide = shapeStakeholders(raw, book);
  const people = slide.stakeholders;
  const relations = slide.relations;
  const left = [...nameFlags(slide), ...islandFlags(slide)];
  const bookQuotes = new Map(book.quotes.map((q) => [q.id, { ...q }]));
  const answerHash = artifactHash(raw);
  await ctx.step(
    "gates",
    async () =>
      stepResult({
        output: { flags, left, retried: flags.length > 0, answer: answerHash },
        validation: [
          passedGates(
            {
              stakeholders: people.length,
              relations: relations.length,
              flags,
              left,
              quotesVerified: book.quotes.length,
              quotesRejected: book.rejected,
              quotesReattributed: book.reattributed,
            },
            left.length ? `${left.length} gate flag(s) left after the retry.` : null,
          ),
        ],
      }),
    { inputs: { check: GATES_CHECK, answer: answerHash } },
  );
  if (!people.length)
    throw new RecipeFailed("The session's transcripts hold no group with something at stake.");

  await ctx.progress("embedding", { force: true });
  const projection = getObjectType("stakeholder").map;
  if (!projection) throw new Error("stakeholder has no map projection");
  const payloads = new Map(
    people.map((p) => [String(p.id), stakeholderPayload(p, bookQuotes, keys)]),
  );
  const textsByHash = new Map<string, string>();
  for (const payload of payloads.values()) {
    const text = projection.embeddingText(payload);
    textsByHash.set(inputHash(text), text);
  }
  const hits = ctx.metric("cacheHits");
  const resumed = ctx.metric("stepsResumed");
  const embedded = await ctx.step<Json>(
    "embed",
    async () => {
      const identity = await services.probe();
      const service = new EmbeddingService(ctx.store, identity, services.embed);
      const batch = await service.ensure(ctx.projectId, textsByHash.values());
      await service.verifyDurable(ctx.projectId, batch.ids.values());
      return stepResult({
        output: {
          ids: Object.fromEntries(batch.ids),
          configKey: service.key,
          model: identity.model,
          reused: batch.reused,
          computed: batch.computed,
        },
      });
    },
    {
      inputs: {
        embedding: { ...((ctx.inputManifest.embedding as Json | undefined) ?? {}) },
        projectionVersion: projection.projectionVersion,
        inputHashes: [...textsByHash.keys()].sort(),
      },
    },
  );
  if (fresh(ctx, hits, resumed)) {
    ctx.count("embeddingsReused", Number(embedded.reused));
    ctx.count("embeddingsComputed", Number(embedded.computed));
  }

  // Objects, then the relations between them.
  await ctx.progress("emitting", { force: true });
  const ids = embedded.ids as Record<string, string>;
  const emitted = new Map<string, ObjectRevision>();
  for (const person of people) {
    const payload = payloads.get(String(person.id)) as Json;
    const hashed = inputHash(projection.embeddingText(payload));
    emitted.set(
      String(person.id),
      await ctx.emit("stakeholder", lineageKey(String(person.name)), payload, {
        sourceRefs: sourceRefs(
          ((person.quoteIds as string[] | undefined) ?? []).map(String),
          bookQuotes,
          keys,
          hashes,
        ),
        embeddingRefs: {
          ...refJson({
            embeddingId: ids[hashed] as string,
            inputHash: hashed,
            configKey: String(embedded.configKey),
            projectionVersion: projection.projectionVersion,
          }),
          model: embedded.model,
        },
        extra: { prompt: STAKEHOLDERS_PROMPT, model: deployment, slideId: person.id },
      }),
    );
    ctx.count("stakeholders");
  }
  for (const relation of relations) {
    const ends = ((relation.between as unknown[] | undefined) ?? []).map((e) =>
      emitted.get(String(e)),
    );
    const [from, to] = ends;
    if (ends.length !== 2 || !from || !to || from.id === to.id) continue;
    const quoteIds = ((relation.aspects as Json[] | undefined) ?? []).flatMap((a) =>
      ((a.quoteIds as string[] | undefined) ?? []).map(String),
    );
    await ctx.relate("stakeholder_relation", from, to, {
      basis: "extracted",
      attributes: relationAttributes(relation, bookQuotes, keys),
      sourceRefs: sourceRefs(quoteIds, bookQuotes, keys, hashes),
    });
    ctx.count("relations");
  }
  ctx.count("gateFlags", left.length);
}

export const RECIPE: Recipe = {
  id: RECIPE_ID,
  version: RECIPE_VERSION,
  name: "Stakeholders",
  purpose:
    "Map the groups with something at stake in a session and how they stand to one another, each group carrying how well the transcripts evidence it.",
  inputTypes: [],
  steps: STEPS,
  outputTypes: ["stakeholder"],
  execute,
  resolveInputs,
  validationRules: [
    "one group per name, and every group connected to the map",
    "every quote is verbatim in the conversation it is credited to; an aspect without one is dropped",
    "absence from the corpus is never evidence of a position: the rung says how a group is evidenced",
    "relations connect groups this run published, and no relation to an argument or a tension is invented",
    "gate flags left after the retry are recorded with the output, not hidden",
  ],
  identityPolicy: {
    description:
      "A group keeps its identity while the room's name for it stays the same; the slide's `s1` is a position in a list and never an identity.",
  },
  embeddingProjections: ["stakeholder"],
  scopeKeyPattern: /^project$/,
  modelConfig: modelDeployment,
  modelConcurrency: 2,
  // Both calls name the corpus they read, so an unchanged conversation keeps the judgement fresh.
  partitionedInputs: ["sources", "sourceFingerprint", "embedding"],
};
