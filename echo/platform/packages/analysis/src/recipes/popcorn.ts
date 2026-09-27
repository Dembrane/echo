import type { Json } from "../contracts";
import { q } from "../db";
import { EmbeddingService, inputHash, refJson } from "../embeddings";
import { type RecipeContext, RecipeFailed, stepResult } from "../executor";
import { pyFind } from "../maprecipe";
import type { InputRequest, Recipe, RecipeServices, StepDef } from "../registry";
import type { AnalysisStore } from "../store";
import { normalizeText, normKey, sha256Hex } from "../text";
import { getObjectType } from "../types";
import { artifactHash, fresh, LOCATION_BASIS, liveModelDeployment } from "./arguments";
import { isVerbatim, norm, POPCORN_PROMPT, VALIDATE_PROMPT } from "./popcorn-shared";
import { loadTranscripts, modelDeployment, producerServices } from "./services";

/**
 * Popcorn: a session's short phrases as shared analysis objects. Scope
 * `conversation:<id>`, one output per conversation, so replacing one conversation's output
 * never removes another's objects. No model call is made here: the live tick produces the
 * phrases, and this recipe turns what the room was shown into typed, revisioned objects
 * (collect the pinned phrases, check each quote is still verbatim, embed the phrase).
 */

export const RECIPE_ID = "popcorn";
export const RECIPE_VERSION = "popcorn-v1";
export const GROUND_CHECK = "popcorn-quote-verbatim-v1";
export const SCOPE_KEY = /^conversation:[0-9a-f-]{36}$/;
/** What the session calls a phrase that the payload schema does not carry, kept on provenance. */
export const CARRIED = ["kind", "qualifiers", "verbatim", "quoteId", "phraseId", "rooted"];
export const SOURCES_KEY = "popcorn_sources";

const STEPS: StepDef[] = [
  {
    key: "collect",
    version: "1",
    kind: "deterministic",
    description: "The conversation's phrases as the session held them when the run was requested",
  },
  {
    key: "ground",
    version: "1",
    kind: "check",
    description:
      "Each phrase's quote is still in its transcript word for word, and the phrase is verbatim or it is not",
    checkVersion: GROUND_CHECK,
  },
  {
    key: "embed",
    version: "1",
    kind: "deterministic",
    description: "Embed each phrase's projection, reusing stored vectors",
  },
];

export const scopeKeyFor = (conversationId: string) => `conversation:${conversationId}`;

export function conversationOf(scopeKey: string): string {
  if (!SCOPE_KEY.test(scopeKey))
    throw new RecipeFailed("This run's scope does not name a conversation.");
  return scopeKey.split(":").slice(1).join(":");
}

/** A phrase's identity within its conversation: its wording, normalised. */
export const phraseKey = (phrase: string) => sha256Hex(norm(phrase)).slice(0, 20);

/** One conversation as the session holds it: its transcript and the phrases on the stage. */
export interface ConversationPhrases {
  readonly conversationId: string;
  readonly text: string;
  readonly phrases: readonly Json[];
  readonly label?: string | null;
  readonly createdAt?: string | null;
  readonly language?: string | null;
  /** The voice note the extractor was given, and the prompt versions that wrote the phrases. */
  readonly voice?: string;
  readonly prompts?: Readonly<Record<string, string>>;
}

export interface PopcornSources {
  conversation(projectId: string, conversationId: string): Promise<ConversationPhrases | null>;
}

function phraseRecord(item: Json, quotes: ReadonlyMap<string, Json>): Json | null {
  const phrase = normalizeText(item.phrase || "");
  if (!phrase) return null;
  const quoteId = String(item.quoteId || "");
  const quote = quotes.get(quoteId) ?? {};
  return {
    phraseId: String(item.id || ""),
    phrase,
    question: Boolean(item.question),
    kind: String(item.kind || "") || null,
    qualifiers: ((item.qualifiers as unknown[] | undefined) || []).map(String),
    quoteId: quoteId || null,
    quote: String(quote.text || "") || null,
  };
}

/** The conversation's items as phrase records, one per wording. */
export function phraseRecords(items: unknown, quotes: ReadonlyMap<string, Json>): Json[] {
  const out: Json[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = phraseRecord(item as Json, quotes);
    if (!record) continue;
    const key = phraseKey(String(record.phrase));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

const VOICE_PRESETS: Record<string, string> = {
  gentle:
    "Prefer the gentler of two ways the room said a thing. Leave out phrases that name, blame or single out a person.",
  plain:
    "Prefer the plainest wording the room used. Leave out metaphors and jokes the room did not return to.",
  decisions:
    "Favour the ideas that became a decision, a need or a next step over ideas that were only discussed.",
};

/** The text appended to the extractor's user message, or empty for the default voice. */
export function voiceHostNote(raw: unknown): string {
  const voice = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Json) : {};
  let chosen = voice.presets;
  if (!Array.isArray(chosen)) chosen = typeof voice.preset === "string" ? [voice.preset] : [];
  const presets = Object.keys(VOICE_PRESETS).filter((k) => (chosen as unknown[]).includes(k));
  const note = [...normalizeText(voice.note || "")].slice(0, 600).join("");
  return [...presets.map((k) => VOICE_PRESETS[k] as string), note]
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * The default source: the project's popcorn session as it stands (latest popcorn report,
 * its latest loop's state, the conversation's transcript). The tick injects its own.
 */
export function sessionSources(store: AnalysisStore): PopcornSources {
  return {
    async conversation(projectId, conversationId) {
      const [report] = await q<{ id: string }>(
        store.sql,
        `SELECT id::text AS id FROM project_report
          WHERE project_id = $1 AND kind = 'popcorn' AND deleted_at IS NULL
          ORDER BY date_created DESC NULLS LAST, id DESC LIMIT 1`,
        [projectId],
      );
      if (!report) return null;
      const [loop] = await q<{ popcorn_state: Json | null; name: string | null }>(
        store.sql,
        "SELECT popcorn_state, name FROM agent_loop WHERE report_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT 1",
        [report.id],
      );
      if (!loop) return null;
      const state =
        loop.popcorn_state && typeof loop.popcorn_state === "object" ? loop.popcorn_state : {};
      const conversations = (state.conversations as Record<string, Json> | undefined) ?? {};
      const entry = conversations[conversationId];
      if (!entry || typeof entry !== "object") return null;
      const transcript = (await loadTranscripts(store, projectId)).find(
        (t) => t.id === conversationId,
      );
      if (!transcript) return null;
      const [config] = await q<{ popcorn_settings: Json | null }>(
        store.sql,
        "SELECT popcorn_settings FROM canvas_config_revision WHERE report_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT 1",
        [report.id],
      );
      const settings = config?.popcorn_settings ?? {};
      const recipeSettings = (settings.recipe_settings as Json | undefined) ?? {};
      const voice = "voice" in recipeSettings ? recipeSettings.voice : settings.voice;
      const quotes = new Map(
        ((state.quotes as Json[] | undefined) ?? [])
          .filter((x) => x && typeof x === "object" && x.id)
          .map((x) => [String(x.id), x]),
      );
      return {
        conversationId,
        text: transcript.text,
        phrases: phraseRecords(entry.items, quotes),
        label: transcript.label || null,
        createdAt: transcript.createdAt || null,
        voice: voiceHostNote(voice),
        prompts: { extract: POPCORN_PROMPT, validate: VALIDATE_PROMPT },
      };
    },
  };
}

/**
 * The popcorn sources the executor was given: the tick injects its own, and the worker and
 * API register sessionSources(store) for requests made outside a tick.
 */
function sourcesOf(services: RecipeServices): PopcornSources {
  const found = services[SOURCES_KEY] as PopcornSources | undefined;
  if (!found) throw new RecipeFailed("This conversation has no popcorn session to publish.");
  return found;
}

async function read(services: RecipeServices, projectId: string, conversationId: string) {
  const found = await sourcesOf(services).conversation(projectId, conversationId);
  if (!found) throw new RecipeFailed("This conversation has no popcorn session to publish.");
  return found;
}

export async function resolveInputs(request: InputRequest): Promise<Json> {
  const conversationId = conversationOf(request.scopeKey);
  const source = await read(request.services, request.projectId, conversationId);
  const services = producerServices(request.services);
  return {
    conversation: {
      conversationId: source.conversationId,
      textHash: sha256Hex(source.text),
      label: source.label ?? null,
      createdAt: source.createdAt ?? null,
      language: source.language ?? null,
    },
    // The phrases themselves are the input: the run publishes exactly what the room was shown.
    phrases: [...source.phrases],
    voice: source.voice ? sha256Hex(source.voice).slice(0, 20) : "",
    prompts: { ...(source.prompts ?? {}) },
    embedding: { ...services.embeddingSettings() },
  };
}

const location = (transcriptKey: string, quote: string): Json | null => {
  const found = pyFind(transcriptKey, normKey(quote));
  return found >= 0 ? { offset: found, basis: LOCATION_BASIS } : null;
};

/** The ground step's per-phrase result: a quote counts only while the transcript still holds it. */
export function groundPhrases(
  phrases: readonly Json[],
  text: string,
): { grounded: Json[]; missing: number } {
  const transcriptKey = normKey(text);
  let missing = 0;
  const grounded = phrases.map((phrase) => {
    const quote = String(phrase.quote || "");
    const found = Boolean(quote) && transcriptKey.includes(normKey(quote));
    if (quote && !found) missing++;
    return {
      ...phrase,
      quote: found ? quote : null,
      quoteId: found ? (phrase.quoteId ?? null) : null,
      verbatim: isVerbatim(String(phrase.phrase), text),
    };
  });
  return { grounded, missing };
}

export async function execute(ctx: RecipeContext): Promise<void> {
  const services = producerServices(ctx.services);
  const conversation = { ...((ctx.inputManifest.conversation as Json | undefined) ?? {}) };
  const conversationId = String(conversation.conversationId || "");
  const pinned = ((ctx.inputManifest.phrases as Json[] | undefined) ?? []).map((p) => ({ ...p }));
  const source = await read(ctx.services, ctx.projectId, conversationId);
  const textHash = sha256Hex(source.text);
  if (textHash !== conversation.textHash)
    throw new RecipeFailed(
      "This conversation changed after the run pinned its phrases. Read it again.",
    );

  await ctx.progress("collecting", { force: true });
  const collected = await ctx.step<Json>(
    "collect",
    async () => stepResult({ output: { phrases: pinned } }),
    {
      inputs: { conversationId, phrases: artifactHash(pinned) },
    },
  );
  const phrases = [...(collected.phrases as Json[])];
  const transcriptKey = normKey(source.text);
  const checked = [
    ...((
      await ctx.step<Json>(
        "ground",
        async () => {
          const { grounded, missing } = groundPhrases(phrases, source.text);
          return stepResult({
            output: { phrases: grounded },
            validation: [
              {
                check: "quote-verbatim",
                status: "passed",
                version: GROUND_CHECK,
                evidence: {
                  phrases: grounded.length,
                  withQuote: grounded.filter((p) => p.quote).length,
                  quotesNotFound: missing,
                  verbatim: grounded.filter((p) => p.verbatim).length,
                },
              },
            ],
          });
        },
        { inputs: { check: GROUND_CHECK, textHash, phrases: artifactHash(phrases) } },
      )
    ).phrases as Json[]),
  ];

  await ctx.progress("embedding", { force: true });
  const projection = getObjectType("popcorn").map;
  if (!projection) throw new Error("popcorn has no map projection");
  const texts = new Map<string, string>();
  for (const p of checked) {
    const text = projection.embeddingText({ phrase: p.phrase });
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
        embedding: { ...((ctx.inputManifest.embedding as Json | undefined) ?? {}) },
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
  const deployment = liveModelDeployment(ctx);
  const prompts = { ...((ctx.inputManifest.prompts as Json | undefined) ?? {}) };
  const ids = embedded.ids as Record<string, string>;
  for (const phrase of checked) {
    const text = String(phrase.phrase);
    const quote = phrase.quote as string | null;
    const hashed = inputHash(projection.embeddingText({ phrase: text }));
    await ctx.emit(
      "popcorn",
      `${conversationId}:${phraseKey(text)}`,
      {
        phrase: text,
        question: Boolean(phrase.question),
        language: conversation.language ?? null,
        evidence: [
          {
            conversationId,
            label: conversation.label ?? null,
            createdAt: conversation.createdAt ?? null,
            quotes: quote ? [quote] : [],
          },
        ],
      },
      {
        sourceRefs: quote
          ? [
              {
                conversationId,
                sourceFingerprint: textHash,
                quote,
                location: location(transcriptKey, quote),
              },
            ]
          : [],
        embeddingRefs: {
          ...refJson({
            embeddingId: ids[hashed] as string,
            inputHash: hashed,
            configKey: String(embedded.configKey),
            projectionVersion: projection.projectionVersion,
          }),
          model: embedded.model,
        },
        // What the payload schema does not carry: kind, qualifiers, quotation marks, deck ids.
        extra: {
          ...Object.fromEntries(
            CARRIED.filter((k) => phrase[k] !== null && phrase[k] !== undefined).map((k) => [
              k,
              phrase[k],
            ]),
          ),
          prompts,
          model: deployment,
        },
      },
    );
  }
  ctx.count("phrases", checked.length);
  ctx.count("phrasesWithQuote", checked.filter((p) => p.quote).length);
  ctx.count("phrasesVerbatim", checked.filter((p) => p.verbatim).length);
}

export const RECIPE: Recipe = {
  id: RECIPE_ID,
  version: RECIPE_VERSION,
  name: "Popcorn",
  purpose:
    "Publish one conversation's short phrases, as the room read them, with the quote each was rooted in and what the second pass made of it.",
  inputTypes: [],
  steps: STEPS,
  outputTypes: ["popcorn"],
  execute,
  resolveInputs,
  validationRules: [
    "one output per conversation: republishing one never touches another's objects",
    "a quote reaches an object only while its transcript still holds it word for word",
    "a rewritten phrase is a new object, never a silent rewrite of the one the room read",
    "every phrase's vector is durable before publication",
  ],
  identityPolicy: {
    description:
      "A phrase keeps its identity while its conversation and its wording stay the same; a phrase the second pass rewrote is a new object.",
  },
  embeddingProjections: ["popcorn"],
  scopeKeyPattern: SCOPE_KEY,
  modelConfig: modelDeployment,
};
