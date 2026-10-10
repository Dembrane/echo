import { type AccessStore, resolveProject } from "@dembrane/access";
import type { ExecutorDeps } from "@dembrane/analysis";
import { newId } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";
import { buildBundle } from "../bundle";
import { applyPublishedObjects, type DeckAnalysis } from "../deck";
import { publishNudge } from "../events";
import {
  asIdTruthy,
  dict,
  directusTime,
  isRecord,
  type Json,
  list,
  orStr,
  parseDt,
  pyIso,
  pyJson,
  truthy,
  utcNowIso,
} from "../py";
import {
  forgetBundle,
  isPopcornLoop,
  liveBooking,
  type PopcornFlags,
  projectJson,
  withoutBooking,
} from "../service";
import {
  audienceManifest,
  DEFAULT_CADENCE_MINUTES,
  MIN_CADENCE_MINUTES,
  normalizeSettings,
  resolvePresentationSettings,
  targetLanguages,
  voiceHostNote,
} from "../settings";
import { freshState, normalizeState, referencedQuoteIds } from "../state";
import { FINISH_TICK, type PopcornStore, type Row, START_TICK } from "../storage";
import { norm as normText } from "../text";
import {
  cacheKey,
  missingTexts,
  popcornTexts,
  translatableTexts,
  translatedBundle,
} from "../translate";
import { applyResults, enrichItem } from "./enrichment";
import { gateItems, introducedNames, knownShingles } from "./flags";
import { islandFlags, nameFlags } from "./gates";
import { groundItems } from "./grounding";
import { POPCORN_PROMPT, type PopcornModel, promptText, VALIDATE_PROMPT } from "./model";
import { Publisher } from "./publish";
import {
  allocateChars,
  buildCorpus,
  MAX_ANALYSIS_CHARS,
  QuoteBook,
  shapePopcornItems,
  shapeStakeholders,
} from "./shapes";
import { STALE_TICK_SECONDS, type TickStore } from "./storage";
import { runPipeline, PROMPT_NAMES as TENSION_PROMPTS } from "./tensions";
import { errText, f, failureText, Mutex, Semaphore, settle, sha1Hex, withTimeout } from "./util";

/**
 * The popcorn tick (popcorn ticks.py): gather every conversation, pop the changed ones,
 * then analyse. One fast extractor per changed conversation, all at once, each phrase
 * published the moment it lands; then the second pass over those conversations and the
 * session analysis side by side. Reads on request (manual, rerun, translation, prepare)
 * go ahead in any mode; the scheduled chain answers to the mode and the expiry. Each
 * analysis view is committed on its own, stamped with the session it read.
 */

// Parallel extractors per tick; the fast group keeps up with sixteen.
export const MAX_PARALLEL_EXTRACTORS = 16;
// Second-pass calls in flight (two per phrase); the pass starts after every first phrase.
export const MAX_PARALLEL_ENRICHMENT = 8;
// Calls in flight for the tensions pipeline, beside the stakeholders call.
export const MAX_PARALLEL_ANALYSIS = 12;
// The stakeholders call reads the whole session; one silent this long is not answering.
export const STAKEHOLDERS_TIMEOUT_MS = 300_000;
// Guards the prompt against a runaway recording; bounds what the model reads, never
// what is fingerprinted or quoted.
export const MAX_CHARS_PER_CONVERSATION = 150_000;
export const ANALYSIS_VIEWS = ["tensions", "stakeholders"] as const;
/**
 * Reads outside the live chain, in any mode: the ones a host asked for, and the read a
 * finished conversation booked. They never change the mode or the live window.
 */
export const ON_REQUEST = new Set([
  "manual",
  FINISH_TICK,
  "rerun",
  "translation",
  "prepare:popcorn",
  "prepare:tensions",
  "prepare:stakeholders",
]);
export const MANUAL_LOCK_WAIT_SECONDS = 180;
// A running tick says so every HEARTBEAT; the beat lives STALE_TICK_SECONDS, so a dead
// worker is noticed within one cadence and a slow second pass is not.
export const HEARTBEAT_MS = 30_000;

export interface TickDeps {
  readonly sql: postgres.Sql;
  readonly store: PopcornStore;
  readonly ticks: TickStore;
  readonly access: AccessStore;
  readonly model: PopcornModel;
  readonly deck: DeckAnalysis;
  /** The analysis executor the tick publishes through; null runs the tick on its state alone. */
  readonly analysis: ExecutorDeps | null;
  /**
   * Present's adopt_results after a read: the presentation's first bindings, or the newest
   * result of every outcome when `newest` (the session is live).
   */
  readonly adoptResults?:
    | ((report: Row, projectId: string, newest: boolean) => Promise<void>)
    | null;
  /** Asks for a new argument map. Its run is its own workflow, beside the read. */
  readonly requestMap?: ((projectId: string, actorId: string | null) => Promise<void>) | null;
  /** Tells the project's people that the read of a booked start is ready to review. */
  readonly notifyReady?: ((o: { projectId: string; reportId: string }) => Promise<void>) | null;
  readonly flags: PopcornFlags;
  readonly participantBaseUrl: string;
  readonly adminBaseUrl: string;
  readonly logger: Logger;
  readonly now: () => Date;
  /**
   * The run lease's holder token. Derived from the workflow id, so a workflow resumed on
   * another worker keeps the lease its first execution took.
   */
  readonly token: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly heartbeatMs?: number;
  readonly manualLockWaitSeconds?: number;
  readonly callTimeoutMs?: number;
}

export interface TickOutcome {
  readonly status: string;
  readonly run: Row;
  readonly state?: Json;
}

// ── small parts ────────────────────────────────────────────────────────

export function fingerprint(text: string): string {
  return sha1Hex(text).slice(0, 16);
}

/**
 * What the model reads of a conversation: all of it, or on a runaway recording its most
 * recent `cap` characters from the next line break.
 */
export function modelWindow(text: string, cap = MAX_CHARS_PER_CONVERSATION): string {
  const cps = [...text];
  if (cps.length <= cap) return text;
  const tail = cps.slice(-cap);
  const cut = tail.indexOf("\n");
  return 0 <= cut && cut < 2000 ? tail.slice(cut + 1).join("") : tail.join("");
}

/** Label and short label for the legend, from the participant name. */
export function labelsFor(participantName: unknown, index: number): [string, string] {
  const name = orStr(participantName).trim();
  const full = name || `Conversation ${index}`;
  const cps = [...full];
  return [full, cps.length <= 24 ? full : `${cps.slice(0, 23).join("")}…`];
}

async function createRun(
  d: TickDeps,
  o: {
    loopId: string;
    status: string;
    startedAt: Date;
    detail?: string | null;
    requestId?: string | null;
  },
): Promise<Row> {
  const id = o.requestId || newId();
  const detail = [...(o.detail ?? "")].slice(0, 5000).join("") || null;
  const payload = {
    id,
    loopId: o.loopId,
    status: o.status,
    detail,
    startedAt: pyIso(o.startedAt),
    finishedAt: utcNowIso(d.now()),
  };
  // An on-request tick's durable backup carries the same id; its retry replaces the
  // failed attempt instead of colliding with the row already written.
  const existing = o.requestId ? await d.ticks.run(id) : null;
  if (existing && asIdTruthy(existing.loop_id) === o.loopId) return d.ticks.replaceRun(payload);
  return d.ticks.insertRun(payload);
}

/** Serialise ticks per loop; an unreachable store is not a reason to stop the room. */
async function claimRunLock(d: TickDeps, loopId: string): Promise<boolean> {
  try {
    return await d.ticks.claimLease(loopId, d.token);
  } catch {
    d.logger.warn({ loop_id: loopId }, "popcorn run lease unavailable");
    return true;
  }
}

async function releaseRunLock(d: TickDeps, loopId: string) {
  try {
    await d.ticks.releaseLease(loopId, d.token);
  } catch {
    d.logger.warn({ loop_id: loopId }, "popcorn run lease release failed");
  }
}

async function renewRunLock(d: TickDeps, loopId: string) {
  try {
    await d.ticks.renewLease(loopId, d.token);
  } catch {
    d.logger.warn({ loop_id: loopId }, "popcorn run lease renewal failed");
  }
}

async function popcornEnabledForLoop(d: TickDeps, loop: Row): Promise<boolean> {
  const { present, canvas } = d.flags;
  if (!present && !canvas) return false;
  const projectId = asIdTruthy(loop.project_id);
  if (!projectId) return false;
  let project: Row | null;
  try {
    project = await d.store.project(projectId);
  } catch {
    return false;
  }
  if (!project) return false;
  return present || (canvas && truthy(project.is_canvas_enabled));
}

async function updateLoopAfterTick(d: TickDeps, loop: Row, status: string) {
  const loopId = String(loop.id);
  const now = utcNowIso(d.now());
  if (status === "ok") {
    await d.store.updateLoop(loopId, { failure_count: 0 }, now);
    return;
  }
  if (status === "error") {
    const failures = (truthy(loop.failure_count) ? Number(loop.failure_count) : 0) + 1;
    const patch: Json = { failure_count: failures };
    if (failures >= 3) patch.status = "paused";
    await d.store.updateLoop(loopId, patch, now);
  }
}

/** A read finished and the next is booked: pages showing its status follow without polling. */
async function nudgeLoop(d: TickDeps, loop: Row) {
  const reportId = asIdTruthy(loop.report_id);
  if (reportId) await publishNudge(d.sql, reportId, d.logger);
}

/**
 * One chain per loop, in any mode: pending ticks are cancelled and, while live, the
 * next is booked one cadence out (or just before the expiry).
 */
export async function enqueueNextIfDue(d: TickDeps, loop: Row, when?: Date): Promise<void> {
  const loopId = String(loop.id);
  const now = d.now();
  // A read a finished conversation booked stays: this read may have gathered before it ended.
  await d.store.cancelPendingTicks(loopId, utcNowIso(now), { keepFinish: true });
  const fresh = await d.store.loop(loopId);
  if (fresh?.status !== "active") return;
  const expiresAt = parseDt(fresh.expires_at);
  if (expiresAt && now >= expiresAt) {
    // Live ended: back to manual, nothing more booked.
    await d.store.updateLoop(loopId, { status: "paused" }, utcNowIso(now));
    return;
  }
  const cadence = Math.max(
    MIN_CADENCE_MINUTES,
    truthy(fresh.cadence_minutes) ? Number(fresh.cadence_minutes) : DEFAULT_CADENCE_MINUTES,
  );
  let nextAt = when ?? new Date(now.getTime() + cadence * 60_000);
  if (expiresAt && nextAt >= expiresAt) {
    const finalAt = new Date(expiresAt.getTime() - 5_000);
    if (finalAt > now) nextAt = finalAt;
    else {
      await d.store.updateLoop(loopId, { status: "paused" }, utcNowIso(now));
      return;
    }
  }
  const nowIso = utcNowIso(now);
  await d.store.scheduleTick({
    id: newId(),
    payload: { loop_id: loopId, tick_kind: "scheduled" },
    scheduledAt: pyIso(nextAt),
    now: nowIso,
  });
}

// ── gather ─────────────────────────────────────────────────────────────

class ReaderDenied extends Error {}

/**
 * Every conversation with its full transcript so far, oldest first so marker colours stay
 * stable. The acting user must still reach the project.
 */
export async function gatherTranscripts(d: TickDeps, projectId: string, actingUser: string) {
  const [appUser] =
    await d.sql`select id from app_user where directus_user_id = ${actingUser} limit 1`;
  if (!appUser) throw new ReaderDenied("403: User not onboarded");
  const project = await d.store.project(projectId);
  if (!project || project.deleted_at) throw new ReaderDenied("Project not found");
  const access = await resolveProject(
    d.access,
    projectId,
    { appUserId: String(appUser.id), directusUserId: actingUser },
    d.now(),
  );
  if (!access) throw new ReaderDenied("Project access denied");
  const { conversations, chunks } = await d.store.transcripts(projectId);
  const byConversation = new Map<string, string[]>();
  for (const chunk of chunks) {
    const cid = asIdTruthy(chunk.conversation_id);
    const text = orStr(chunk.transcript).trim();
    if (cid && text) byConversation.set(cid, [...(byConversation.get(cid) ?? []), text]);
  }
  const out: Json[] = [];
  conversations.forEach((conv, i) => {
    const cid = asIdTruthy(conv.id);
    if (!cid) return;
    const text = (byConversation.get(cid) ?? []).join("\n").trim();
    if (!text) return;
    const [label, short] = labelsFor(conv.participant_name, i + 1);
    out.push({
      id: cid,
      label,
      short,
      created_at: directusTime(conv.created_at),
      duration: conv.duration ?? null,
      text,
    });
  });
  return out;
}

// ── the writer and the translator ──────────────────────────────────────

/**
 * Single writer for the loop's state row: every completion is written straight away so
 * the stage sees it, and the lock keeps two completions from clobbering each other.
 */
class TickWriter {
  private readonly lock = new Mutex();
  constructor(
    private readonly d: TickDeps,
    readonly loopId: string,
    readonly reportId: string,
    public state: Json,
  ) {}

  async flush(): Promise<void> {
    await this.lock.run(async () => {
      await this.d.store.updateLoop(
        this.loopId,
        { popcorn_state: this.state },
        utcNowIso(this.d.now()),
      );
      // The memo goes first so the nudge's reader sees this write.
      forgetBundle(this.reportId);
      await publishNudge(this.d.sql, this.reportId, this.d.logger);
    });
    await renewRunLock(this.d, this.loopId);
  }
}

/**
 * One bounded translation dispatcher inside the tick: extractors submit phrases once
 * their originals are flushed, for every language asked for, and a text in flight is
 * never paid for twice.
 */
class IncrementalTranslator {
  private readonly tables = new Map<string, Json>();
  private readonly inFlight = new Set<string>();
  private readonly claims = new Mutex();
  private readonly dispatch = new Semaphore(1);

  constructor(
    private readonly d: TickDeps,
    private readonly writer: TickWriter,
    private readonly targets: readonly string[],
  ) {
    const state = writer.state;
    if (!isRecord(state.translations)) state.translations = {};
    const translations = state.translations as Json;
    for (const target of targets) {
      if (!isRecord(translations[target])) translations[target] = {};
      this.tables.set(target, translations[target] as Json);
    }
  }

  async submit(texts: readonly string[]): Promise<void> {
    for (const target of this.targets) await this.submitOne(target, texts);
  }

  private async submitOne(target: string, texts: readonly string[]) {
    const table = this.tables.get(target) as Json;
    const claimed: [string, string][] = await this.claims.run(async () => {
      const out: [string, string][] = [];
      for (const text of texts) {
        if (typeof text !== "string" || !text.trim()) continue;
        const key = cacheKey(text, target);
        if (key in table || this.inFlight.has(key)) continue;
        this.inFlight.add(key);
        out.push([key, text]);
      }
      return out;
    });
    if (!claimed.length) return;
    const store = async (batch: string[], answers: (string | null)[]) => {
      const changed = await this.claims.run(async () => {
        let c = false;
        batch.forEach((source, i) => {
          const answer = answers[i];
          const key = cacheKey(source, target);
          if (answer && table[key] !== answer) {
            table[key] = answer;
            c = true;
          }
        });
        return c;
      });
      if (changed) await this.writer.flush();
    };
    try {
      await this.dispatch.run(() =>
        this.d.model.translate(
          claimed.map(([, t]) => t),
          target,
          store,
          (m) => this.d.logger.warn(m),
        ),
      );
    } catch (exc) {
      this.d.logger.warn({ err: errText(exc) }, "incremental popcorn translation failed");
    } finally {
      await this.claims.run(async () => {
        for (const [key] of claimed) this.inFlight.delete(key);
      });
    }
  }
}

// ── the first pass and the second ──────────────────────────────────────

async function extractOne(
  d: TickDeps,
  writer: TickWriter,
  slots: Semaphore,
  transcript: Json,
  outcomes: string[],
  hostNote: string,
  known: ReadonlySet<string>,
  publisher: Publisher | null,
  translator: IncrementalTranslator | null,
): Promise<void> {
  const cid = String(transcript.id);
  const conversations = writer.state.conversations as Json;
  const entry = conversations[cid] as Json;
  const text = String(transcript.text);
  const window = orStr(transcript.window) || modelWindow(text);
  await slots.run(async () => {
    const started = performance.now();
    try {
      const raw = await d.model.extract({ transcriptId: cid, transcript: window, hostNote });
      const [carriedItems, carried, redropped] = carryForward(
        shapePopcornItems(raw, cid),
        entry,
        text,
        list(writer.state.quotes),
        String(transcript.fingerprint),
      );
      // The gates are code: names, text the room was shown, twins; carried wording too.
      const [kept, suppressed] = gateItems(carriedItems, introducedNames(text), known);
      const items = groundItems(kept, text);
      const review: Json = {};
      const oldDropped = dict(entry.review).dropped;
      if (entry.fingerprint === transcript.fingerprint && truthy(oldDropped))
        review.dropped = oldDropped;
      if (suppressed.length) review.suppressed = suppressed;
      Object.assign(entry, {
        items,
        review,
        revision: (truthy(entry.revision) ? Number(entry.revision) : 0) + 1,
        done: true,
        fingerprint: transcript.fingerprint,
        chars: [...text].length,
        // characters before the model's window, for the host
        clipped: [...text].length - [...window].length,
        extracted_at: utcNowIso(d.now()),
        error: null,
      });
      const ms = Math.trunc(performance.now() - started);
      const held = suppressed.length ? `, ${suppressed.length} held back` : "";
      const again = redropped ? `, ${redropped} held back again` : "";
      const keptNote = carried ? `, ${carried} carried over` : "";
      outcomes.push(
        `popcorn ${cid.slice(0, 8)}: ${items.length} phrases${held}${again}${keptNote} in ${ms} ms`,
      );
    } catch (exc) {
      // A dead transcript must not stall the stage.
      Object.assign(entry, {
        items: truthy(entry.items) ? entry.items : [],
        revision: (truthy(entry.revision) ? Number(entry.revision) : 0) + 1,
        done: true,
        extracted_at: utcNowIso(d.now()),
        error: [...errText(exc)].slice(0, 500).join(""),
      });
      outcomes.push(`popcorn ${cid.slice(0, 8)}: FAILED ${errText(exc)}`);
    }
  });
  await writer.flush();
  if (translator)
    await translator.submit(
      list(entry.items)
        .filter((i) => isRecord(i) && truthy(i.phrase))
        .map((i) => String((i as Json).phrase)),
    );
  if (publisher) await publisher.conversation(writer.state, transcript);
}

async function enrichOne(
  d: TickDeps,
  writer: TickWriter,
  slots: Semaphore,
  transcript: Json,
  outcomes: string[],
  book: QuoteBook,
  publisher: Publisher | null,
): Promise<void> {
  const cid = String(transcript.id);
  const entry = (writer.state.conversations as Json)[cid] as Json;
  // A phrase with its kind and its evidence answer is done; only failures are retried.
  const items = list(entry.items).filter(needsPass) as Json[];
  const text = String(transcript.text);
  // The model reads the window the phrases came from; the names open the whole transcript.
  const window = orStr(transcript.window) || modelWindow(text);
  const names = introducedNames(text);
  const started = performance.now();
  let results: Json[];
  try {
    results = await Promise.all(
      items.map((item) =>
        slots.run(() =>
          enrichItem(item, {
            transcriptId: cid,
            transcript: window,
            names,
            validate: (o) => d.model.validate(o),
            classify: (o) => d.model.classify(o),
            rewrite: (o) => d.model.rewrite(o),
          }),
        ),
      ),
    );
  } catch (exc) {
    outcomes.push(`enrich ${cid.slice(0, 8)}: FAILED ${errText(exc)}`);
    return;
  }
  // Re-read underneath the pass; the next tick enriches the new phrases.
  if (entry.fingerprint !== transcript.fingerprint) return;
  const stats = applyResults(items, results, cid, (tid, quote) =>
    book.add({ transcript: tid, text: quote }),
  );
  // A question rewrite changes the words whose verbatim flag and passage the deck shows.
  groundItems(items, text);
  // A phrase the pass could not root leaves the deck; the host keeps it.
  const dropped = list(entry.items).filter((i) => dict(i).rooted === false) as Json[];
  if (dropped.length) {
    const review: Json = { ...dict(entry.review) };
    review.dropped = [
      ...list(review.dropped),
      ...dropped.map((i) => ({
        id: i.id ?? null,
        phrase: i.phrase ?? null,
        reason: orStr(dict(i.review).evidence),
      })),
    ];
    entry.review = review;
    entry.items = list(entry.items).filter((i) => dict(i).rooted !== false);
  }
  entry.revision = (truthy(entry.revision) ? Number(entry.revision) : 0) + 1;
  const failed = results.reduce((n, r) => n + list(r.errors).length, 0);
  // Only a complete pass is stamped; a failed call keeps the conversation owed.
  if (!failed) entry.validated_fingerprint = transcript.fingerprint;
  writer.state.quotes = [...book.quotes];
  const ms = Math.trunc(performance.now() - started);
  outcomes.push(
    `enrich ${cid.slice(0, 8)}: ${stats.rooted}/${items.length} rooted, ${stats.classified} kinds, ` +
      `${stats.rewritten} rewritten in ${ms} ms` +
      (dropped.length ? `, ${dropped.length} held back` : "") +
      (failed ? `, ${failed} call(s) failed` : ""),
  );
  await writer.flush();
  // The second pass rewrote, rooted and dropped phrases: the objects are published again.
  if (publisher) await publisher.conversation(writer.state, transcript);
}

/** The conversations still owed a second pass on the transcript as it stands. */
export function pendingEnrichment(state: Json, transcripts: readonly Json[]): Json[] {
  const conversations = dict(state.conversations);
  return transcripts.filter((t) => {
    const conv = conversations[String(t.id)];
    return (
      isRecord(conv) &&
      truthy(conv.done) &&
      truthy(conv.items) &&
      conv.validated_fingerprint !== t.fingerprint
    );
  });
}

/** A phrase still owed the second pass: no kind, no evidence verdict, or a failed call. */
export function needsPass(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (!("kind" in item) || !("rooted" in item)) return true;
  return truthy(dict(item.review).errors);
}

/**
 * Reuse each phrase's reviewed wording and any quote still in the source. Rejections
 * apply only to the fingerprint they were checked against. Returns kept items, carried
 * evidence count and repeated rejection count.
 */
export function carryForward(
  items: Json[],
  entry: Json,
  text: string,
  quotes: readonly unknown[],
  fp: string,
): [Json[], number, number] {
  const previous = new Map(
    list(entry.items)
      .filter((i): i is Json => isRecord(i) && truthy(i.id))
      .map((i) => [String(i.id), i]),
  );
  const dropped = new Set(
    list(dict(entry.review).dropped)
      .filter((x): x is Json => isRecord(x) && truthy(x.id) && entry.fingerprint === fp)
      .map((x) => String(x.id)),
  );
  const byQuote = new Map(
    quotes.filter((q): q is Json => isRecord(q) && truthy(q.id)).map((q) => [String(q.id), q]),
  );
  const kept: Json[] = [];
  let carried = 0;
  let redropped = 0;
  for (const item of items) {
    const iid = String(item.id);
    if (dropped.has(iid)) {
      redropped++;
      continue;
    }
    const old = previous.get(iid);
    if (old === undefined) {
      kept.push(item);
      continue;
    }
    for (const key of ["phrase", "kind", "question", "qualifiers", "review"])
      if (key in old) item[key] = old[key];
    const quote = byQuote.get(orStr(old.quoteId));
    if (old.rooted === true && quote && normText(text).includes(normText(orStr(quote.text)))) {
      item.quoteId = old.quoteId;
      item.rooted = true;
    }
    if ("kind" in item && "rooted" in item) carried++;
    kept.push(item);
  }
  return [kept, carried, redropped];
}

/** The registry after a run: every quote something on the deck still cites. */
function referencedQuotes(state: Json, quotes: readonly Json[]): Json[] {
  const ids = referencedQuoteIds(dict(state.conversations));
  referencedQuoteIds(dict(state.analysis), ids);
  return quotes.filter((q) => ids.has(q.id as string));
}

// ── the analysis ───────────────────────────────────────────────────────

async function runAnalysisPass(
  d: TickDeps,
  transcripts: readonly Json[],
  outcomes: string[],
  book: QuoteBook,
  views: readonly string[],
  publisher: Publisher | null,
): Promise<Record<string, Json | null>> {
  const lengths = new Map(transcripts.map((t) => [String(t.id), [...String(t.text)].length]));
  const quota = allocateChars(lengths, MAX_ANALYSIS_CHARS);
  const sources = new Map(
    transcripts.map((t) => [
      String(t.id),
      [...String(t.text)].slice(0, quota.get(String(t.id))).join(""),
    ]),
  );
  const clipped = [...lengths].filter(([tid, n]) => (quota.get(tid) as number) < n);
  if (clipped.length) {
    const read = [...quota.values()].reduce((a, b) => a + b, 0);
    const total = [...lengths.values()].reduce((a, b) => a + b, 0);
    outcomes.push(
      `analysis corpus: ${read} of ${total} chars read, ${clipped.length} of ${lengths.size} conversations cut short`,
    );
  }
  const corpus = buildCorpus([...sources]);
  const shaped: Record<string, Json | null> = { tensions: null, stakeholders: null };

  const stakeholdersSlide = async () => {
    const started = performance.now();
    if (publisher) {
      const published = await publisher.stakeholders(transcripts, book);
      if (published !== null) {
        // The recipe made the one call this slide needs: the objects the Map draws are the slide.
        shaped.stakeholders = published;
        const ms = Math.trunc(performance.now() - started);
        outcomes.push(
          `stakeholders: ${list(published.stakeholders).length} items, ${list(published.relations).length} relations in ${ms} ms, published`,
        );
        return;
      }
    }
    const answer = () => withTimeout(() => d.model.stakeholders(corpus), STAKEHOLDERS_TIMEOUT_MS);
    let raw = await answer();
    // The gates read a shaped answer; a throwaway book keeps a rejected answer's quotes out.
    const probe = shapeStakeholders(raw, new QuoteBook(sources));
    const flags = [...nameFlags(probe), ...islandFlags(probe)];
    if (flags.length)
      raw = await withTimeout(() => d.model.stakeholders(corpus, flags), STAKEHOLDERS_TIMEOUT_MS);
    const slide = shapeStakeholders(raw, book);
    shaped.stakeholders = slide;
    const left = [...nameFlags(slide), ...islandFlags(slide)];
    const ms = Math.trunc(performance.now() - started);
    outcomes.push(
      `stakeholders: ${list(slide.stakeholders).length} items, ${list(slide.relations).length} relations in ${ms} ms` +
        (flags.length ? `, ${flags.length} gate flag(s), asked again` : "") +
        (left.length ? `, ${left.length} left` : ""),
    );
  };

  const tensionsSlide = async () => {
    const started = performance.now();
    const result = await runPipeline(sources, book, {
      generate: (o) => d.model.analysis(o),
      prompts: Object.fromEntries(TENSION_PROMPTS.map((n) => [n, promptText(n)])),
      concurrency: MAX_PARALLEL_ANALYSIS,
      ...(d.callTimeoutMs !== undefined && { callTimeoutMs: d.callTimeoutMs }),
    });
    shaped.tensions = result.tensions;
    const c = result.counts;
    const ms = Math.trunc(performance.now() - started);
    outcomes.push(
      `tensions: ${list(result.tensions.tensions).length} items in ${ms} ms ` +
        `(${c.positions ?? 0} positions, ${c.candidates ?? 0} pairs, ${c.cross_table ?? 0} across tables, ${c.verified ?? 0} verified)` +
        (result.gate_flags.length ? `, ${result.gate_flags.length} screen flag(s) left` : ""),
    );
  };

  const jobs: Record<string, () => Promise<void>> = {
    stakeholders: stakeholdersSlide,
    tensions: tensionsSlide,
  };
  const wanted = Object.keys(jobs).filter((k) => views.includes(k));
  const results = await settle(wanted.map((k) => (jobs[k] as () => Promise<void>)()));
  wanted.forEach((kind, i) => {
    const r = results[i];
    if (r instanceof Error) {
      outcomes.push(`${kind}: FAILED ${failureText(r)}`);
      shaped[kind] = null;
    }
  });
  outcomes.push(
    `quotes: ${book.quotes.length} verified, ${book.rejected} rejected` +
      (book.reattributed ? `, ${book.reattributed} credited to the table that said them` : ""),
  );
  return shaped;
}

/** The analysis views not yet computed over this session's transcripts. */
export function staleViews(state: Json, analysisFingerprint: string, views: readonly string[]) {
  const held = dict(dict(state.analysis).fingerprints);
  return views.filter((kind) => held[kind] !== analysisFingerprint);
}

/** Presentation-backed sessions prepare only the blocks in their manifest. */
export function selectedAnalysisViews(settings: Json): string[] {
  if (!isRecord(settings.presentation)) return [...ANALYSIS_VIEWS];
  const blocks = list(settings.presentation.blocks);
  return ANALYSIS_VIEWS.filter((k) => blocks.includes(k));
}

/**
 * Each view on its own: a fresh slide replaces the old one, stamped with the session it
 * read; a failed view keeps its previous slide unless it cites a conversation now gone.
 */
export function commitViews(
  state: Json,
  fresh: Record<string, Json | null>,
  analysisFingerprint: string,
  heldQuotes: ReadonlySet<string>,
  outcomes: string[],
  nowIso: string,
): void {
  const previous = dict(state.analysis);
  const fingerprints: Json = { ...dict(previous.fingerprints) };
  const updated: Json = { ...dict(previous.updated) };
  const analysis: Json = { fingerprints, updated };
  for (const kind of ANALYSIS_VIEWS) {
    const slide = fresh[kind];
    if (slide !== null && slide !== undefined) {
      analysis[kind] = slide;
      fingerprints[kind] = analysisFingerprint;
      updated[kind] = nowIso;
      continue;
    }
    let kept: unknown = previous[kind];
    if (truthy(kept) && [...referencedQuoteIds(kept)].some((q) => !heldQuotes.has(q))) {
      outcomes.push(`${kind}: previous slide dropped, it cited a conversation that is gone`);
      kept = null;
    }
    analysis[kind] = kept ?? null;
    if (kept === null || kept === undefined) {
      delete fingerprints[kind];
      delete updated[kind];
    }
  }
  if (!ANALYSIS_VIEWS.some((kind) => truthy(analysis[kind]))) {
    state.analysis = null;
    return;
  }
  const times = Object.values(updated).map(String);
  analysis.updated_at = times.length ? times.reduce((a, b) => (b > a ? b : a)) : nowIso;
  state.analysis = analysis;
}

// ── what the room reads, saved runs and translation ────────────────────

async function withEffectiveLegalBasis(d: TickDeps, project: Json, settings: Json): Promise<Json> {
  if (!truthy(dict(settings.data).enabled) || !truthy(project.id)) return project;
  const rows = await d.store.legalCascade(project);
  const level = [project, rows.workspace, rows.owner].find((l) => l && truthy(l.legal_basis));
  return {
    ...project,
    legal_basis: level ? level.legal_basis : "client-managed",
    privacy_policy_url: level ? (level.privacy_policy_url ?? null) : null,
  };
}

/** The bundle the room reads, published objects applied, in the original language. */
async function roomBundle(
  d: TickDeps,
  reportId: string,
  state: Json,
  settings: Json,
  projectId: string,
): Promise<Json> {
  const row = await d.store.project(projectId);
  const report = await d.store.report(reportId);
  const project = await withEffectiveLegalBasis(
    d,
    row ? projectJson(row) : { id: projectId },
    settings,
  );
  let bundle = buildBundle({
    state,
    settings,
    report: report ?? { id: reportId },
    project,
    participantBaseUrl: d.participantBaseUrl,
    adminBaseUrl: d.adminBaseUrl,
    // A saved run replays on the wall: no passages, no dashboard links.
    host: false,
    now: d.now(),
  });
  try {
    const objects = await d.deck.deckObjects(projectId);
    bundle = applyPublishedObjects(bundle, objects, { settings, project, host: false });
  } catch {
    d.logger.warn({ project_id: projectId }, "popcorn deck: published objects unavailable");
  }
  return bundle;
}

/** The files as Python held them: a transcript's duration is float(duration). */
function withFloats(files: Json): Json {
  const session = files["session.json"];
  if (!isRecord(session) || !Array.isArray(session.transcripts)) return files;
  return {
    ...files,
    "session.json": {
      ...session,
      transcripts: session.transcripts.map((t) =>
        isRecord(t) && typeof t.duration === "number" ? { ...t, duration: f(t.duration) } : t,
      ),
    },
  };
}

/** Snapshot the room's bundle after a tick, so a run can be replayed later. */
async function snapshotVersion(
  d: TickDeps,
  o: {
    reportId: string;
    configId: string | null;
    state: Json;
    settings: Json;
    projectId: string;
    tickKind: string;
    detail: string;
  },
) {
  const bundle = translatedBundle(
    await roomBundle(d, o.reportId, o.state, o.settings, o.projectId),
    o.state,
    o.settings,
  );
  await d.ticks.insertVersion({
    reportId: o.reportId,
    configId: o.configId,
    html: pyJson({ files: withFloats(dict(bundle.files)) }),
    tickKind: o.tickKind,
    detail: [...o.detail].slice(0, 5000).join(""),
    now: utcNowIso(d.now()),
  });
}

class TranslationIncomplete extends Error {}

/**
 * The host's translation brought up to date with what the room's deck shows now, one
 * language at a time. The first language carries the whole deck, the extra ones the
 * phrases. A translation-only job has no next read, so `requireComplete` fails it when
 * texts are left over and its same-id backup may retry.
 */
async function translateSession(
  d: TickDeps,
  state: Json,
  settings: Json,
  o: { reportId: string; projectId: string; writer: TickWriter | null; requireComplete?: boolean },
): Promise<string | null> {
  const targets = targetLanguages(settings);
  if (!targets.length) return null;
  const files = dict((await roomBundle(d, o.reportId, state, settings, o.projectId)).files);
  if (!isRecord(state.translations)) state.translations = {};
  const translations = state.translations as Json;
  const counted: string[] = [];
  const short: string[] = [];
  for (const [index, target] of targets.entries()) {
    const texts = index === 0 ? translatableTexts(files) : popcornTexts(files);
    // Only the texts on the deck now are kept: a rerun's old phrases go.
    const shown = new Set(texts.map((t) => cacheKey(t, target)));
    const previous = dict(translations[target]);
    const table: Json = Object.fromEntries(Object.entries(previous).filter(([k]) => shown.has(k)));
    translations[target] = table;
    const gaps = missingTexts(files, table, target, texts);
    if (!gaps.length) {
      if (o.writer && Object.keys(table).length !== Object.keys(previous).length)
        await o.writer.flush();
      continue;
    }
    const store = async (batch: string[], answers: (string | null)[]) => {
      let changed = false;
      batch.forEach((source, i) => {
        const text = answers[i];
        if (text && table[cacheKey(source, target)] !== text) {
          table[cacheKey(source, target)] = text;
          changed = true;
        }
      });
      if (changed && o.writer) await o.writer.flush();
    };
    const answers = await d.model.translate(gaps, target, store, (m) => d.logger.warn(m));
    counted.push(`${answers.filter(Boolean).length} of ${gaps.length} texts into ${target}`);
    const left = missingTexts(files, table, target, texts).length;
    if (left) short.push(`${left} not translated into ${target}`);
  }
  if (!counted.length) return null;
  const outcome = `translated ${counted.join("; ")}`;
  if (o.requireComplete && short.length)
    throw new TranslationIncomplete(`${outcome}, ${short.join(", ")}`);
  return outcome;
}

// ── the tick ───────────────────────────────────────────────────────────

export async function runPopcornTick(
  d: TickDeps,
  loopId: string,
  tickKind = "scheduled",
  requestId: string | null = null,
): Promise<TickOutcome> {
  const startedAt = d.now();
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  let loop = await d.store.loop(loopId);
  if (!loop || !isPopcornLoop(loop)) throw new Error("Popcorn loop not found");

  if (!(await popcornEnabledForLoop(d, loop))) {
    const run = await createRun(d, {
      loopId,
      status: "no_op",
      detail: "Popcorn is disabled for this project",
      startedAt,
    });
    return { status: "disabled", run };
  }

  // A booked start ("Ready by"): live from now until the expiry booked with it, then this
  // read runs as a manual one and the chain books the next.
  if (tickKind === START_TICK) {
    if (!liveBooking(loop)) {
      const run = await createRun(d, {
        loopId,
        status: "no_op",
        detail: "No start booked",
        startedAt,
      });
      return { status: "no_op", run };
    }
    await d.store.updateLoop(
      loopId,
      { status: "active", failure_count: 0, caps: withoutBooking(loop.caps) },
      utcNowIso(d.now()),
    );
    // Pages showing "Ready by" turn live now, whatever the read finds.
    await nudgeLoop(d, loop);
    const first = await runPopcornTick(d, loopId, "manual", requestId);
    const bookedReport = asIdTruthy(loop.report_id);
    // A read that found nothing new is as ready as one that did.
    if ((first.status === "ok" || first.status === "no_op") && bookedReport && d.notifyReady) {
      try {
        await d.notifyReady({ projectId: orStr(loop.project_id), reportId: bookedReport });
      } catch (exc) {
        // The results are there either way; the inbox message is a courtesy.
        d.logger.warn({ err: errText(exc), loop_id: loopId }, "ready notice not sent");
      }
    }
    return first;
  }

  // Only the scheduled chain answers to the mode and the expiry.
  if (!ON_REQUEST.has(tickKind)) {
    if (loop.status !== "active") {
      const run = await createRun(d, {
        loopId,
        status: "no_op",
        detail: `Loop is ${loop.status === null || loop.status === undefined ? "None" : String(loop.status)}`,
        startedAt,
      });
      return { status: "no_op", run };
    }
    const expiresAt = parseDt(loop.expires_at);
    if (expiresAt && startedAt >= expiresAt) {
      // Live ended: back to manual. The deck stays; refresh still works.
      await d.store.updateLoop(
        loopId,
        { status: "paused", expires_at: pyIso(startedAt) },
        utcNowIso(d.now()),
      );
      const run = await createRun(d, {
        loopId,
        status: "no_op",
        detail: "Live ended; back to manual",
        startedAt,
      });
      return { status: "no_op", run };
    }
  }

  if (!(await claimRunLock(d, loopId))) {
    // A host pressing read-again mid-tick expects the new speech read: wait for the lease.
    let claimed = false;
    if (ON_REQUEST.has(tickKind)) {
      const rounds = Math.floor((d.manualLockWaitSeconds ?? MANUAL_LOCK_WAIT_SECONDS) / 2);
      for (let i = 0; i < rounds; i++) {
        await sleep(2000);
        if (await claimRunLock(d, loopId)) {
          claimed = true;
          break;
        }
      }
    }
    if (!claimed) {
      const run = await createRun(d, {
        loopId,
        status: "no_op",
        detail: "A tick is already running",
        startedAt,
      });
      return { status: "duplicate", run };
    }
    // The tick that just finished wrote the state; read it, not the earlier snapshot.
    loop = (await d.store.loop(loopId)) ?? loop;
  }

  const reportId = asIdTruthy(loop.report_id);
  const projectId = asIdTruthy(loop.project_id);
  const actingUser = orStr(loop.acting_directus_user_id);
  let beating = true;
  let wake: (() => void) | null = null;
  const pulse = (async () => {
    while (beating) {
      try {
        await d.ticks.markAlive(loopId);
      } catch {
        d.logger.warn({ loop_id: loopId }, "popcorn heartbeat unavailable");
      }
      await renewRunLock(d, loopId);
      await new Promise<void>((r) => {
        const timer = setTimeout(r, d.heartbeatMs ?? HEARTBEAT_MS);
        wake = () => {
          clearTimeout(timer);
          r();
        };
      });
    }
  })();
  const currentLoop = loop;
  try {
    if (!reportId || !projectId || !actingUser)
      throw new Error("Popcorn loop is missing required ids");

    // Both deliveries of an on-request tick carry the same id; a finished run ends the second.
    if (requestId) {
      const completed = await d.ticks.run(requestId);
      if (
        completed &&
        asIdTruthy(completed.loop_id) === loopId &&
        (completed.status === "ok" || completed.status === "no_op")
      )
        return { status: "duplicate", run: completed };
    }

    // The next read is booked before this one starts, so a worker that dies mid-read costs
    // the room one cadence and never the chain.
    await enqueueNextIfDue(d, currentLoop);

    let state = normalizeState(currentLoop.popcorn_state);
    if (tickKind === "rerun") {
      // Wiped here, under the lease: the run counter goes on, the saved runs stay.
      const previousRun = state.run;
      const kept: Json = {};
      for (const k of ["demo", "translations"]) if (truthy(state[k])) kept[k] = state[k];
      state = freshState();
      state.run = previousRun;
      Object.assign(state, kept);
    }
    // What the room has been shown so far: a new phrase quoting it is the tool quoting itself.
    const knownAll = knownShingles(state);
    const knownBy = new Map(
      Object.keys(dict(state.conversations)).map((cid) => [cid, knownShingles(state, 6, cid)]),
    );
    const config = await d.store.latestConfig(reportId);
    let settings = normalizeSettings(config?.popcorn_settings, orStr(currentLoop.name, "Popcorn"));
    const project = await d.store.project(projectId);
    settings = resolvePresentationSettings(settings, project ? projectJson(project) : {});
    let analysisViews: readonly string[] = selectedAnalysisViews(settings);
    const prepareKind = tickKind.startsWith("prepare:") ? tickKind.slice("prepare:".length) : null;
    if (prepareKind === "popcorn") analysisViews = [];
    else if (prepareKind && (ANALYSIS_VIEWS as readonly string[]).includes(prepareKind))
      analysisViews = [prepareKind];

    const finish = async (status: string) => {
      await updateLoopAfterTick(d, currentLoop, status);
      await enqueueNextIfDue(d, currentLoop);
      await nudgeLoop(d, currentLoop);
    };

    if (tickKind === "translation") {
      const writer = new TickWriter(d, loopId, reportId, state);
      let translated: string | null;
      try {
        translated = await translateSession(d, state, settings, {
          reportId,
          projectId,
          writer,
          requireComplete: true,
        });
      } catch (exc) {
        // The room keeps its original words.
        const run = await createRun(d, {
          loopId,
          status: "error",
          detail: `translation failed: ${failureText(exc)}`,
          startedAt,
          requestId,
        });
        await finish("error");
        return { status: "error", run, state };
      }
      const changed = Boolean(translated);
      const run = await createRun(d, {
        loopId,
        status: changed ? "ok" : "no_op",
        detail: translated || "No translation work owed",
        startedAt,
        requestId,
      });
      await finish("ok");
      return { status: changed ? "ok" : "no_op", run, state };
    }

    const hostNote = voiceHostNote(settings.voice);
    const transcripts = await gatherTranscripts(d, projectId, actingUser);
    for (const t of transcripts) {
      // The whole transcript and the voice: a change of either re-reads the conversation.
      t.fingerprint = fingerprint(`${t.text}\x1f${hostNote}`);
      t.window = modelWindow(String(t.text));
    }

    const conversations = state.conversations as Json;
    const order = state.order as string[];
    const changed: Json[] = [];
    for (const t of transcripts) {
      const cid = String(t.id);
      let entry = conversations[cid] as Json | undefined;
      if (entry === undefined) {
        entry = { id: cid, revision: 0, done: false, items: [] };
        conversations[cid] = entry;
        order.push(cid);
      }
      entry.label = t.label;
      entry.short = t.short;
      entry.created_at = t.created_at;
      entry.duration = t.duration ?? null;
      if (entry.fingerprint !== t.fingerprint || !truthy(entry.done)) changed.push(t);
    }
    // A conversation that vanished leaves the deck with it.
    const present = new Set(transcripts.map((t) => String(t.id)));
    const vanished = Object.keys(conversations).filter((cid) => !present.has(cid));
    for (const cid of vanished) delete conversations[cid];
    state.order = order.filter((cid) => present.has(cid));
    if (vanished.length && !transcripts.length) {
      // The last conversation is gone: nothing derived from it may stay on the deck.
      state.analysis = null;
      state.quotes = [];
      await d.store.updateLoop(loopId, { popcorn_state: state }, utcNowIso(d.now()));
      await publishNudge(d.sql, reportId, d.logger);
    }

    const analysisFingerprint = fingerprint(
      transcripts.map((t) => `${t.id}:${t.fingerprint}`).join("|"),
    );
    const analysisStale =
      transcripts.length > 0 && staleViews(state, analysisFingerprint, analysisViews).length > 0;
    const preparesPopcorn = prepareKind === null || prepareKind === "popcorn";
    const extractionWork = preparesPopcorn ? changed : [];
    const owed = preparesPopcorn ? pendingEnrichment(state, transcripts) : [];

    // Nothing new, nothing owed, no view stale: nothing to do, unless a rerun wiped it.
    if (!extractionWork.length && !analysisStale && !owed.length && tickKind !== "rerun") {
      const translationWriter = new TickWriter(d, loopId, reportId, state);
      let translated: string | null;
      try {
        translated = await translateSession(d, state, settings, {
          reportId,
          projectId,
          writer: translationWriter,
        });
      } catch (exc) {
        d.logger.warn({ err: errText(exc) }, "popcorn translation failed");
        translated = null;
      }
      if (translated) {
        const run = await createRun(d, {
          loopId,
          status: "ok",
          detail: translated,
          startedAt,
          requestId,
        });
        await enqueueNextIfDue(d, currentLoop);
        await nudgeLoop(d, currentLoop);
        return { status: "ok", run, state };
      }
      const run = await createRun(d, {
        loopId,
        status: "no_op",
        detail: "No new transcript content since the last tick",
        startedAt,
        requestId,
      });
      await enqueueNextIfDue(d, currentLoop);
      await nudgeLoop(d, currentLoop);
      return { status: "no_op", run };
    }

    state.run = (truthy(state.run) ? Number(state.run) : 0) + 1;
    // A conversation being re-read shows as reading until its extractor lands.
    for (const t of extractionWork) (conversations[String(t.id)] as Json).done = false;
    const writer = new TickWriter(d, loopId, reportId, state);
    const targets = targetLanguages(settings);
    const translator = targets.length ? new IncrementalTranslator(d, writer, targets) : null;
    // The legend and the listening stage need the transcript list before any phrase lands.
    await writer.flush();

    const outcomes: string[] = [];
    // What the tick reads reaches the shared store through the executor, for the producer
    // scopes it owns.
    const publisher = d.analysis
      ? new Publisher(
          { executor: d.analysis, deck: d.deck, logger: d.logger },
          projectId,
          outcomes,
          hostNote,
        )
      : null;
    // The argument map is part of the same run: asked for here, it works as its own
    // workflow while this read extracts. One already running is left to finish.
    if (
      d.requestMap &&
      transcripts.length &&
      (extractionWork.length || tickKind === "rerun") &&
      list(audienceManifest(settings).blocks).includes("map")
    ) {
      try {
        await d.requestMap(projectId, actingUser || null);
      } catch (exc) {
        // The read goes on without a new map.
        d.logger.warn({ err: errText(exc), project_id: projectId }, "map not requested");
      }
    }
    if (extractionWork.length) {
      const slots = new Semaphore(MAX_PARALLEL_EXTRACTORS);
      await Promise.all(
        extractionWork.map((t) =>
          extractOne(
            d,
            writer,
            slots,
            t,
            outcomes,
            hostNote,
            knownBy.get(String(t.id)) ?? knownAll,
            publisher,
            translator,
          ),
        ),
      );
    }

    // One quote registry for the tick, seeded with the session's so the deck's ids stay valid.
    const names = new Set<string>();
    for (const t of transcripts) for (const n of introducedNames(String(t.text))) names.add(n);
    const book = new QuoteBook(
      new Map(transcripts.map((t) => [String(t.id), String(t.text)])),
      names,
      list(state.quotes),
    );

    // Now that every first phrase is on the stage: the second pass and the analysis at once.
    const secondPass = async () => {
      const pending = preparesPopcorn ? pendingEnrichment(state, transcripts) : [];
      if (pending.length) {
        const slots = new Semaphore(MAX_PARALLEL_ENRICHMENT);
        await Promise.all(
          pending.map((t) => enrichOne(d, writer, slots, t, outcomes, book, publisher)),
        );
      }
    };
    const analysisPass = async () => {
      if (!transcripts.length || !(analysisStale || extractionWork.length || tickKind === "rerun"))
        return;
      // A changed session is analysed whole; one with only a view left stale redoes that view.
      const views =
        extractionWork.length || tickKind === "rerun"
          ? analysisViews
          : staleViews(state, analysisFingerprint, analysisViews);
      const fresh = await runAnalysisPass(d, transcripts, outcomes, book, views, publisher);
      commitViews(
        state,
        fresh,
        analysisFingerprint,
        new Set(book.quotes.map((q) => String(q.id))),
        outcomes,
        utcNowIso(d.now()),
      );
    };
    await Promise.all([secondPass(), analysisPass()]);
    if (transcripts.length) {
      state.quotes = referencedQuotes(state, book.quotes);
      await writer.flush();
    }
    let translated: string | null;
    try {
      translated = await translateSession(d, state, settings, { reportId, projectId, writer });
    } catch (exc) {
      translated = `translation failed: ${failureText(exc)}`;
    }
    if (translated) outcomes.push(translated);

    const detail = [
      `run ${state.run}: ${extractionWork.length} of ${transcripts.length} conversations re-read` +
        (tickKind === "rerun" ? " (rerun: the previous state wiped)" : ""),
      ...outcomes,
    ].join("; ");
    const run = await createRun(d, { loopId, status: "ok", detail, startedAt, requestId });
    let snapshotted = false;
    try {
      await snapshotVersion(d, {
        reportId,
        configId: asIdTruthy(config?.id),
        state,
        settings,
        projectId,
        tickKind,
        detail,
      });
      snapshotted = true;
    } catch (exc) {
      // A failed snapshot must not fail the tick.
      d.logger.warn({ err: errText(exc), report_id: reportId }, "popcorn version snapshot failed");
    }
    if (snapshotted && isRecord(settings.presentation) && d.adoptResults) {
      try {
        const report = await d.store.report(reportId);
        // Live, the room follows every outcome; otherwise a binding the host chose stays.
        const live = (await d.store.loop(loopId))?.status === "active";
        if (report) await d.adoptResults(report, projectId, live);
      } catch (exc) {
        // The audience keeps its existing bindings.
        d.logger.warn({ err: errText(exc) }, "initial presentation result adoption failed");
      }
    }
    await finish("ok");
    return { status: "ok", run, state };
  } catch (exc) {
    const detail = exc instanceof Error ? exc.message : String(exc);
    const run = await createRun(d, { loopId, status: "error", detail, startedAt });
    await updateLoopAfterTick(d, currentLoop, "error");
    await enqueueNextIfDue(d, currentLoop);
    await nudgeLoop(d, currentLoop);
    d.logger.warn({ loop_id: loopId, detail }, "popcorn tick failed");
    return { status: "error", run };
  } finally {
    beating = false;
    (wake as (() => void) | null)?.();
    await pulse;
    try {
      await d.ticks.clearAlive(loopId);
    } catch {
      d.logger.warn({ loop_id: loopId }, "popcorn heartbeat clear failed");
    }
    await releaseRunLock(d, loopId);
  }
}

// ── the reconciler ─────────────────────────────────────────────────────

/** Backfill one pending scheduled tick for each active popcorn loop missing one. */
export async function reconcileMissingTicks(d: TickDeps): Promise<number> {
  if (!d.flags.present && !d.flags.canvas) return 0;
  const now = d.now();
  const loops = (await d.ticks.activeLoops(pyIso(now))).filter((l) => isPopcornLoop(l));
  if (!loops.length) return 0;
  const covered = new Set<string>();
  for (const task of await d.ticks.pendingTasks()) {
    const loopId = orStr(dict(task.payload).loop_id);
    if (!loopId) continue;
    if (task.status === "scheduled") covered.add(loopId);
    else if (task.status === "processing") {
      const claimedAt = parseDt(task.claimed_at);
      // Stranded: claimed longer ago than the beat lives, and no beat.
      const fresh =
        claimedAt !== null && (now.getTime() - claimedAt.getTime()) / 1000 <= STALE_TICK_SECONDS;
      if (fresh || (await d.ticks.alive(loopId).catch(() => false))) covered.add(loopId);
      else {
        const taskId = orStr(task.id);
        d.logger.warn({ task_id: taskId, loop_id: loopId }, "rescuing stranded popcorn tick task");
        if (taskId)
          try {
            await d.ticks.failTask(
              taskId,
              "Stale processing claim rescued by popcorn reconciler",
              pyIso(now),
            );
          } catch (exc) {
            d.logger.warn({ task_id: taskId, err: errText(exc) }, "failed to mark stranded task");
          }
      }
    }
  }
  let enqueued = 0;
  for (const loop of loops) {
    const loopId = orStr(loop.id);
    if (!loopId || covered.has(loopId)) continue;
    await enqueueNextIfDue(d, loop, now);
    enqueued++;
  }
  return enqueued;
}

export { POPCORN_PROMPT, VALIDATE_PROMPT };
