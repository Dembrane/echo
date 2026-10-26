import {
  type ConversationPhrases,
  type ExecutorDeps,
  executeInline,
  POPCORN_RECIPE_ID,
  POPCORN_SOURCES_KEY,
  POPCORN_TENSIONS_RECIPE_ID,
  POPCORN_TENSIONS_SOURCES_KEY,
  type PopcornSources,
  type PopcornTensionSources,
  PRODUCERS_KEY,
  type ProducerServices,
  phraseRecords,
  popcornScopeKey,
  type SessionTension,
  type Transcript,
} from "@dembrane/analysis";
import type { Logger } from "@dembrane/observability";
import { type DeckAnalysis, stakeholdersSlide, tensionsSlideFrom } from "../deck";
import { dict, isRecord, type Json, list, orStr, truthy } from "../py";
import { POPCORN_PROMPT, VALIDATE_PROMPT } from "./model";
import type { QuoteBook } from "./shapes";
import { failureText, sha1Hex } from "./util";

const STAKEHOLDERS_RECIPE_ID = "stakeholders";
const PROJECT_SCOPE = "project";

export interface PublisherDeps {
  readonly executor: ExecutorDeps;
  readonly deck: DeckAnalysis;
  readonly logger: Logger;
}

/**
 * What the tick reads, published into the shared analysis store, inline (ticks.py
 * _Publisher). One conversation's phrases are one output of the `popcorn` recipe and the
 * session's groups one output of `stakeholders`, each through the executor's run, step and
 * publication rows like every other recipe. Phrases are published after the state is
 * written, so the stage still shows a phrase the moment its extractor lands.
 *
 * Only where the executor owns the producer scope: a session waiting for its import belongs
 * to the legacy writer alone. Nothing here may cost the room its deck, so a store that is
 * missing, busy or broken leaves an outcome line and the tick goes on.
 */
export class Publisher {
  private readonly owned = new Map<string, boolean>();
  /** This read published the session's tensions, or found them not its to publish. */
  tensionsSettled = false;

  constructor(
    private readonly d: PublisherDeps,
    private readonly projectId: string,
    private readonly outcomes: string[],
    private readonly hostNote = "",
  ) {}

  private async mayWrite(recipeId: string, scopeKey: string): Promise<boolean> {
    const key = `${recipeId}@${scopeKey}`;
    let owns = this.owned.get(key);
    if (owns === undefined) {
      try {
        owns = await this.d.deck.owns(this.projectId, recipeId, scopeKey);
      } catch {
        // A store that cannot answer is not an answer: this read keeps to the session's state.
        this.d.logger.warn(`popcorn: the analysis store did not answer for ${key}`);
        owns = false;
      }
      this.owned.set(key, owns);
    }
    return owns;
  }

  /**
   * Publish one conversation's phrases as they now stand. The entry records the revision
   * that reached the store (`published_revision`), so a conversation whose publication
   * failed is published again by a later read rather than staying provisional on the deck.
   */
  async conversation(state: Json, transcript: Json): Promise<void> {
    const cid = String(transcript.id);
    const scopeKey = popcornScopeKey(cid);
    const held = dict(state.conversations)[cid];
    const settled = (entry: unknown) => {
      if (isRecord(entry)) entry.published_revision = entry.revision ?? null;
    };
    try {
      // A scope the legacy writer owns is not this tick's to publish: nothing is owed.
      if (!(await this.mayWrite(POPCORN_RECIPE_ID, scopeKey))) return settled(held);
      const entry = dict(dict(state.conversations)[cid]);
      const quotes = new Map(
        list(state.quotes)
          .filter((q): q is Json => isRecord(q) && truthy(q.id))
          .map((q) => [String(q.id), q]),
      );
      const source: ConversationPhrases = {
        conversationId: cid,
        text: String(transcript.text),
        phrases: phraseRecords(entry.items, quotes),
        label: orStr(entry.label) || null,
        createdAt: orStr(entry.created_at) || null,
        voice: this.hostNote,
        prompts: { extract: POPCORN_PROMPT, validate: VALIDATE_PROMPT },
      };
      // The recipe's source is exactly the conversation just written: it reads nothing again.
      const one: PopcornSources = {
        conversation: async (_projectId, conversationId) =>
          conversationId === cid ? source : null,
      };
      const executor = this.d.executor;
      const outcome = await executeInline(
        { projectId: this.projectId, recipeId: POPCORN_RECIPE_ID, scopeKey },
        { ...executor, services: { ...executor.services, [POPCORN_SOURCES_KEY]: one } },
      );
      const { status, error } = outcome.run;
      if (status === "ready") settled(held);
      // A superseded run lost to a newer request, which records its own revision.
      else if (status !== "superseded")
        this.outcomes.push(`publish ${cid.slice(0, 8)}: ${status}${error ? ` (${error})` : ""}`);
    } catch (exc) {
      // The deck is the tick's to keep.
      this.d.logger.warn(
        { err: failureText(exc) },
        `popcorn publication failed for conversation ${cid}`,
      );
      this.outcomes.push(`publish ${cid.slice(0, 8)}: FAILED ${failureText(exc)}`);
    }
  }

  /**
   * The deck's objects with this read's publication in them. The outbox advances the deck
   * view after a publication, a moment later; the slide this read writes is made now, so it
   * advances the view itself (the same assembly, safe to race the outbox's).
   */
  private async freshDeck() {
    const snapshot = await this.d.deck.assembleDeck(this.projectId);
    return this.d.deck.deckObjects(this.projectId, snapshot?.id ?? null);
  }

  /**
   * Run the stakeholders recipe over this session and return its slide, or null when the
   * scope is not the executor's. The recipe makes the one call the tick would have made,
   * so nothing is asked twice; its quotes go into the session's own registry.
   */
  async stakeholders(transcripts: readonly Json[], book: QuoteBook): Promise<Json | null> {
    if (!(await this.mayWrite(STAKEHOLDERS_RECIPE_ID, PROJECT_SCOPE))) return null;
    const pinned: Transcript[] = transcripts.map((t) => ({
      id: String(t.id),
      label: orStr(t.label),
      createdAt: (t.created_at as string | null | undefined) ?? null,
      text: String(t.text),
    }));
    const executor = this.d.executor;
    const producers = executor.services[PRODUCERS_KEY] as ProducerServices;
    // The tick has already read the transcripts; the recipe reads the same text.
    const services = { ...producers, transcripts: async () => [...pinned] };
    const outcome = await executeInline(
      { projectId: this.projectId, recipeId: STAKEHOLDERS_RECIPE_ID, scopeKey: PROJECT_SCOPE },
      { ...executor, services: { ...executor.services, [PRODUCERS_KEY]: services } },
    );
    if (outcome.run.status !== "ready")
      throw new Error(outcome.run.error || `the stakeholders run is ${outcome.run.status}`);
    const objects = await this.freshDeck();
    return stakeholdersSlide(objects.stakeholders, objects.relations, (quote) =>
      book.add({ transcript: quote.conversationId, text: quote.text }),
    );
  }

  /**
   * Publish the session's tensions as `popcorn.tensions` objects and return the slide those
   * objects make, or null when the scope is not the executor's. The tick found the tensions;
   * the recipe only grounds, embeds and publishes them, so the room, the results table and
   * the Map read the same objects. A failed run throws: the slide is not committed and the
   * next read tries again.
   */
  async tensions(slide: Json, transcripts: readonly Json[], book: QuoteBook): Promise<Json | null> {
    if (!(await this.mayWrite(POPCORN_TENSIONS_RECIPE_ID, PROJECT_SCOPE))) {
      this.tensionsSettled = true;
      return null;
    }
    const registry = new Map(book.quotes.map((q) => [String(q.id), q]));
    const seen = new Set<string>();
    const tensions: SessionTension[] = [];
    for (const raw of list(slide.tensions)) {
      const t = dict(raw);
      // A slide written before tensions kept an identity gets one from its words and
      // quotes: stable across reads of that same slide, new when the slide changes.
      const identity =
        orStr(t.identity) ||
        `slide-${sha1Hex(
          [
            orStr(t.poleA),
            orStr(t.poleB),
            ...list(t.quoteIds)
              .map((id) => orStr(registry.get(String(id))?.text))
              .sort(),
          ].join("\x1f"),
        ).slice(0, 24)}`;
      // Two tensions on one pair are one object: the first, in the slide's rank order.
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      const poles = dict(t.quotePoles);
      tensions.push({
        identity,
        poleA: orStr(t.poleA),
        poleB: orStr(t.poleB),
        knot: orStr(t.knot),
        toResolve: orStr(t.toResolve),
        quotes: list(t.quoteIds).flatMap((id) => {
          const q = registry.get(String(id));
          if (!q || !truthy(q.text) || !truthy(q.transcript)) return [];
          const pole = poles[String(id)];
          return [
            {
              text: String(q.text),
              conversationId: String(q.transcript),
              pole: pole === "A" || pole === "B" ? pole : null,
            },
          ];
        }),
      });
    }
    const source = {
      tensions,
      transcripts: transcripts.map((t) => ({ id: String(t.id), text: String(t.text) })),
    };
    const one: PopcornTensionSources = { tensions: async () => source };
    const executor = this.d.executor;
    const outcome = await executeInline(
      { projectId: this.projectId, recipeId: POPCORN_TENSIONS_RECIPE_ID, scopeKey: PROJECT_SCOPE },
      { ...executor, services: { ...executor.services, [POPCORN_TENSIONS_SOURCES_KEY]: one } },
    );
    const { status, error } = outcome.run;
    if (status !== "ready" && status !== "superseded")
      throw new Error(error || `the live tensions run is ${status}`);
    const objects = await this.freshDeck();
    this.tensionsSettled = true;
    return tensionsSlideFrom(
      objects.tensions.filter((r) => r.recipeId === POPCORN_TENSIONS_RECIPE_ID),
      (quote) => book.add({ transcript: quote.conversationId, text: quote.text }),
    );
  }
}
