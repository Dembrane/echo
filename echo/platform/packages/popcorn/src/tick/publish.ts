import {
  type ConversationPhrases,
  type ExecutorDeps,
  executeInline,
  POPCORN_RECIPE_ID,
  POPCORN_SOURCES_KEY,
  type PopcornSources,
  PRODUCERS_KEY,
  type ProducerServices,
  phraseRecords,
  popcornScopeKey,
  type Transcript,
} from "@echo/analysis";
import type { Logger } from "@echo/observability";
import { type DeckAnalysis, stakeholdersSlide } from "../deck";
import { dict, isRecord, type Json, list, orStr, truthy } from "../py";
import { POPCORN_PROMPT, VALIDATE_PROMPT } from "./model";
import type { QuoteBook } from "./shapes";
import { failureText } from "./util";

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

  /** Publish one conversation's phrases as they now stand. */
  async conversation(state: Json, transcript: Json): Promise<void> {
    const cid = String(transcript.id);
    const scopeKey = popcornScopeKey(cid);
    try {
      if (!(await this.mayWrite(POPCORN_RECIPE_ID, scopeKey))) return;
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
      if (status !== "ready" && status !== "superseded")
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
    const objects = await this.d.deck.deckObjects(this.projectId);
    return stakeholdersSlide(objects.stakeholders, objects.relations, (quote) =>
      book.add({ transcript: quote.conversationId, text: quote.text }),
    );
  }
}
