import type { Json, SourceRef } from "../contracts";
import { q } from "../db";
import { EmbeddingService, inputHash, refJson } from "../embeddings";
import { type RecipeContext, RecipeFailed, stepResult } from "../executor";
import { pyFind } from "../maprecipe";
import type { InputRequest, Recipe, RecipeServices, StepDef } from "../registry";
import type { AnalysisStore } from "../store";
import { normalizeText, normKey, sha256Hex } from "../text";
import { getObjectType } from "../types";
import { artifactHash, fresh, LOCATION_BASIS, liveModelDeployment } from "./arguments";
import { loadTranscripts, modelDeployment, producerServices } from "./services";

/**
 * A live session's tensions as shared analysis objects. The tick finds them (positions,
 * pairs, verification, writing); this recipe asks no language model, only embedding text it
 * has not embedded before. It publishes what the room is shown, so the room, the results
 * table and the Map read the same objects. Scope `project`, one output per project, beside
 * the host's own `tensions` recipe.
 */

export const RECIPE_ID = "popcorn.tensions";
export const RECIPE_VERSION = "popcorn-tensions-v1";
export const GROUND_CHECK = "popcorn-tension-quote-verbatim-v1";
export const SOURCES_KEY = "popcorn_tensions_sources";
export const SCOPE_KEY = "project";

const STEPS: StepDef[] = [
  {
    key: "collect",
    version: "1",
    kind: "deterministic",
    description: "The session's tensions as the room was shown them when the run was requested",
  },
  {
    key: "ground",
    version: "1",
    kind: "check",
    description: "Each quote is still word for word in the conversation it is credited to",
    checkVersion: GROUND_CHECK,
  },
  {
    key: "embed",
    version: "1",
    kind: "deterministic",
    description: "Embed each tension's projection, reusing stored vectors",
  },
];

/** One tension as the session holds it, quotes resolved to their words and conversation. */
export interface SessionTension {
  /** The identity the session derived from the two positions the tension connects. */
  readonly identity: string;
  readonly poleA: string;
  readonly poleB: string;
  readonly knot: string;
  readonly toResolve: string;
  readonly quotes: readonly { text: string; conversationId: string; pole: "A" | "B" | null }[];
}

export interface SessionTensions {
  readonly tensions: readonly SessionTension[];
  /** Every conversation the quotes may come from, with its whole transcript. */
  readonly transcripts: readonly { id: string; text: string }[];
}

export interface PopcornTensionSources {
  tensions(projectId: string): Promise<SessionTensions | null>;
}

const str = (v: unknown) =>
  typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
const rec = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * A session's tension slide with its quote ids resolved through the session's registry.
 * A tension written before identities were kept has none and is left out: it cannot keep
 * an object across reads.
 */
export function sessionTensions(slide: unknown, registry: unknown): SessionTension[] {
  const quotes = new Map(
    arr(registry)
      .map(rec)
      .filter((q) => str(q.id))
      .map((q) => [str(q.id), q]),
  );
  const out: SessionTension[] = [];
  for (const raw of arr(rec(slide).tensions)) {
    const t = rec(raw);
    const identity = str(t.identity);
    if (!identity) continue;
    const poles = rec(t.quotePoles);
    out.push({
      identity,
      poleA: normalizeText(t.poleA),
      poleB: normalizeText(t.poleB),
      knot: normalizeText(t.knot),
      toResolve: normalizeText(t.toResolve),
      quotes: arr(t.quoteIds)
        .map(str)
        .map((id) => {
          const q = quotes.get(id);
          if (!q || !str(q.text) || !str(q.transcript)) return null;
          const pole = str(poles[id]);
          return {
            text: str(q.text),
            conversationId: str(q.transcript),
            pole: pole === "A" || pole === "B" ? pole : null,
          } as const;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    });
  }
  return out;
}

/**
 * The default source: the project's popcorn session as it stands (latest popcorn report,
 * its latest loop's state, the project's transcripts). The tick injects its own.
 */
export function sessionTensionSources(store: AnalysisStore): PopcornTensionSources {
  return {
    async tensions(projectId) {
      const [report] = await q<{ id: string }>(
        store.sql,
        `SELECT id::text AS id FROM project_report
          WHERE project_id = $1 AND kind = 'popcorn' AND deleted_at IS NULL
          ORDER BY date_created DESC NULLS LAST, id DESC LIMIT 1`,
        [projectId],
      );
      if (!report) return null;
      const [loop] = await q<{ popcorn_state: Json | null }>(
        store.sql,
        "SELECT popcorn_state FROM agent_loop WHERE report_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT 1",
        [report.id],
      );
      const state = rec(loop?.popcorn_state);
      const slide = rec(state.analysis).tensions;
      if (!slide) return null;
      const transcripts = (await loadTranscripts(store, projectId)).map((t) => ({
        id: t.id,
        text: t.text,
      }));
      return { tensions: sessionTensions(slide, state.quotes), transcripts };
    },
  };
}

function sourcesOf(services: RecipeServices): PopcornTensionSources {
  const found = services[SOURCES_KEY] as PopcornTensionSources | undefined;
  if (!found) throw new RecipeFailed("This project has no popcorn session to publish.");
  return found;
}

async function read(services: RecipeServices, projectId: string): Promise<SessionTensions> {
  const found = await sourcesOf(services).tensions(projectId);
  if (!found) throw new RecipeFailed("This project has no popcorn session to publish.");
  return found;
}

/** What each conversation the quotes cite holds, by hash: a changed transcript is a new run. */
function citedHashes(source: SessionTensions): Record<string, string> {
  const cited = new Set(source.tensions.flatMap((t) => t.quotes.map((q) => q.conversationId)));
  return Object.fromEntries(
    source.transcripts
      .filter((t) => cited.has(t.id))
      .map((t) => [t.id, sha256Hex(t.text)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

export async function resolveInputs(request: InputRequest): Promise<Json> {
  const source = await read(request.services, request.projectId);
  const services = producerServices(request.services);
  return {
    // The tensions themselves are the input: the run publishes exactly what the room was shown.
    tensions: source.tensions.map((t) => ({ ...t, quotes: t.quotes.map((x) => ({ ...x })) })),
    textHashes: citedHashes(source),
    embedding: { ...services.embeddingSettings() },
  };
}

/** The tension payload and its source refs: quotes no longer verbatim in their conversation drop. */
export function groundTension(
  t: Json,
  keys: ReadonlyMap<string, string>,
  hashes: ReadonlyMap<string, string>,
): { payload: Json; sourceRefs: SourceRef[]; missing: number } {
  const quotes: Json[] = [];
  const refs: SourceRef[] = [];
  let missing = 0;
  const seen = new Set<string>();
  for (const raw of arr(t.quotes)) {
    const quote = rec(raw);
    const text = str(quote.text);
    const conversationId = str(quote.conversationId);
    const key = normKey(text);
    const found = text ? pyFind(keys.get(conversationId) ?? "", key) : -1;
    if (found < 0) {
      missing++;
      continue;
    }
    const dedupe = `${conversationId}\u0000${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const location = { offset: found, basis: LOCATION_BASIS };
    const pole = str(quote.pole);
    quotes.push({
      text,
      conversationId,
      location,
      pole: pole === "A" || pole === "B" ? pole : null,
    });
    refs.push({
      conversationId,
      sourceFingerprint: hashes.get(conversationId) ?? null,
      quote: text,
      location,
    });
  }
  return {
    payload: {
      poleA: str(t.poleA),
      poleB: str(t.poleB),
      knot: str(t.knot),
      toResolve: str(t.toResolve),
      quotes,
    },
    sourceRefs: refs,
    missing,
  };
}

export async function execute(ctx: RecipeContext): Promise<void> {
  const services = producerServices(ctx.services);
  const pinned = ((ctx.inputManifest.tensions as Json[] | undefined) ?? []).map((t) => ({ ...t }));
  const pinnedHashes = rec(ctx.inputManifest.textHashes);
  const source = await read(ctx.services, ctx.projectId);
  const texts = new Map(source.transcripts.map((t) => [t.id, t.text]));
  for (const [cid, hash] of Object.entries(pinnedHashes))
    if (sha256Hex(texts.get(cid) ?? "") !== hash)
      throw new RecipeFailed(
        "A conversation changed after the run pinned its tensions. Read it again.",
      );
  const hashes = new Map(Object.entries(pinnedHashes).map(([k, v]) => [k, str(v)]));
  const keys = new Map([...texts].map(([cid, text]) => [cid, normKey(text)]));

  await ctx.progress("collecting", { force: true });
  const collected = await ctx.step<Json>(
    "collect",
    async () => stepResult({ output: { tensions: pinned } }),
    { inputs: { tensions: artifactHash(pinned) } },
  );
  const tensions = [...(collected.tensions as Json[])];
  const identities = new Set<string>();
  for (const t of tensions) {
    const identity = str(t.identity);
    if (!identity || identities.has(identity))
      throw new RecipeFailed("Two of the session's tensions claim the same identity.");
    identities.add(identity);
  }

  const grounded = (
    await ctx.step<Json>(
      "ground",
      async () => {
        const out = tensions.map((t) => ({
          identity: str(t.identity),
          ...groundTension(t, keys, hashes),
        }));
        const missing = out.reduce((n, t) => n + t.missing, 0);
        return stepResult({
          output: {
            tensions: out.map(({ identity, payload, sourceRefs }) => ({
              identity,
              payload,
              sourceRefs,
            })),
          },
          validation: [
            {
              check: "quote-verbatim",
              status: "passed",
              version: GROUND_CHECK,
              evidence: {
                tensions: out.length,
                quotes: out.reduce((n, t) => n + arr(t.payload.quotes).length, 0),
                quotesNotFound: missing,
              },
            },
          ],
        });
      },
      { inputs: { check: GROUND_CHECK, hashes: pinnedHashes, tensions: artifactHash(tensions) } },
    )
  ).tensions as Json[];

  await ctx.progress("embedding", { force: true });
  const projection = getObjectType("tension").map;
  if (!projection) throw new Error("tension has no map projection");
  const byHash = new Map<string, string>();
  for (const t of grounded) {
    const text = projection.embeddingText(rec(t.payload));
    byHash.set(inputHash(text), text);
  }
  const hits = ctx.metric("cacheHits");
  const resumed = ctx.metric("stepsResumed");
  const embedded = await ctx.step<Json>(
    "embed",
    async () => {
      if (!byHash.size)
        return stepResult({
          output: { ids: {}, configKey: null, model: null, reused: 0, computed: 0 },
        });
      const identity = await services.probe();
      const service = new EmbeddingService(ctx.store, identity, services.embed);
      const batch = await service.ensure(ctx.projectId, byHash.values());
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
        embedding: { ...rec(ctx.inputManifest.embedding) },
        projectionVersion: projection.projectionVersion,
        inputHashes: [...byHash.keys()].sort(),
      },
    },
  );
  if (fresh(ctx, hits, resumed)) {
    ctx.count("embeddingsReused", Number(embedded.reused));
    ctx.count("embeddingsComputed", Number(embedded.computed));
  }

  await ctx.progress("emitting", { force: true });
  const deployment = liveModelDeployment(ctx);
  const ids = embedded.ids as Record<string, string>;
  for (const t of grounded) {
    const payload = rec(t.payload);
    const hashed = inputHash(projection.embeddingText(payload));
    await ctx.emit("tension", `tension:${str(t.identity)}`, payload, {
      sourceRefs: arr(t.sourceRefs) as SourceRef[],
      embeddingRefs: {
        ...refJson({
          embeddingId: ids[hashed] as string,
          inputHash: hashed,
          configKey: String(embedded.configKey),
          projectionVersion: projection.projectionVersion,
        }),
        model: embedded.model,
      },
      extra: { identity: str(t.identity), model: deployment },
    });
    ctx.count("tensions");
  }
}

export const RECIPE: Recipe = {
  id: RECIPE_ID,
  version: RECIPE_VERSION,
  name: "Live tensions",
  purpose:
    "Publish a live session's tensions, as the room read them, with the quotes that hold each pole.",
  inputTypes: [],
  steps: STEPS,
  outputTypes: ["tension"],
  execute,
  resolveInputs,
  validationRules: [
    "the run publishes exactly the tensions the session pinned; no language model is called",
    "every quote is verbatim in the conversation it is credited to, or it is dropped",
  ],
  identityPolicy: {
    description:
      "A tension keeps its identity while its two poles rest on the same passages of the same conversations, however the positions are worded; the tick carries a published identity to the tension a new read finds on those passages.",
  },
  embeddingProjections: ["tension"],
  scopeKeyPattern: /^project$/,
  modelConfig: modelDeployment,
};
