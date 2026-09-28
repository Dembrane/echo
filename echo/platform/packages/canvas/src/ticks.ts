import { createHash } from "node:crypto";
import type { AccessStore } from "@echo/access";
import type { Completer } from "@echo/llm";
import { executeGatherSpec, gatherHasTranscript } from "./gather";
import { buildCanvasHistory } from "./history";
import {
  applyModelExtraction,
  type CanvasState,
  type ExtractionDetail,
  freshCanvasState,
  hasBoardTab,
  ledgerPromptSummary,
  normalizeCanvasTabs,
  pySlice,
  renderTabbedCanvas,
  seedBoardCardsFromQuotes,
  statePatch,
  type Tab,
  tabsEqual,
} from "./ledgers";
import {
  HOST_GUIDE_SYSTEM_PROMPT,
  MODEL_EXTRACTION_SYSTEM_PROMPT,
  PURPOSE_INSTRUCTION,
} from "./prompts";
import {
  dict,
  directusTime,
  isRecord,
  type Json,
  list,
  orStr,
  parseDt,
  pyStr,
  truthy,
  utcNowIso,
} from "./py";
import { MAX_HTML_BYTES, sanitizeCanvasHtml } from "./sanitize";
import type { CanvasStore } from "./storage";

/**
 * The bounded canvas tick: gather recent transcript, merge receipts into the ledgers with
 * the model, render the wall from the ledgers, store it. Split into phases so the durable
 * workflow checkpoints between them: a crash during the model calls resumes at the model
 * calls, never re-gathering or re-writing what already committed.
 */

export const CANVAS_TRANSCRIPT_WINDOW_CHARS = 20_000;
export const STALE_TICK_SECONDS = 180;

export interface TickDeps {
  readonly store: CanvasStore;
  readonly accessStore: AccessStore;
  readonly completer: Completer;
  readonly canvasEnabled: boolean;
  readonly now: () => Date;
  /** Tells open canvas pages a new generation exists. */
  readonly nudge: (reportId: string) => Promise<void>;
  /** One scheduled tick per loop per cadence window; false when another took it. */
  readonly claimWindow: (loopId: string, window: number, ttlSeconds: number) => Promise<boolean>;
  /** Ids the tick writes, derived from its run so a replayed phase writes the same rows. */
  readonly idFor: (label: string) => string;
}

/** A uuid-shaped id derived from a seed: the same seed always names the same row. */
export function derivedId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const v = `4${h.slice(13, 16)}`;
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function iso(d: Date): string {
  return utcNowIso(d);
}

function isPopcornLoop(loop: Json | null): boolean {
  const caps = loop?.caps;
  return isRecord(caps) && caps.kind === "popcorn";
}

function asId(v: unknown): string | null {
  const value = isRecord(v) ? v.id : v;
  return truthy(value) ? pyStr(value) : null;
}

// ── visible copy checks ─────────────────────────────────────────────

function unescapeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

function visibleText(html: string): string {
  const noHidden = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ");
  return noHidden
    .split(/<[^>]*>/)
    .map((p) => unescapeEntities(p).trim())
    .filter(Boolean)
    .join(" ");
}

export function bannedVisibleCopy(html: string): string[] {
  const text = visibleText(html);
  const lowered = text.toLowerCase();
  const found: string[] = [];
  if (lowered.includes("real-time")) found.push("real-time");
  if (/\bAI\b/.test(text)) found.push("AI");
  if (lowered.includes("successfully")) found.push("successfully");
  if (text.includes("—")) found.push("em dash");
  return found;
}

export function generationDetail(args: {
  strippedReferences: number;
  bannedCopy: string[];
  ledgerDetail?: ExtractionDetail | null;
}): string | null {
  const details: string[] = [];
  if (args.strippedReferences)
    details.push(`stripped ${args.strippedReferences} external reference(s)`);
  if (args.bannedCopy.length) details.push(`banned visible copy: ${args.bannedCopy.join(", ")}`);
  const d = args.ledgerDetail;
  if (d) {
    if (d.backfill_conversations !== undefined && d.backfill_conversations !== null)
      details.push(`backfill: ${d.backfill_conversations} conversations`);
    for (const o of (d.conversation_outcomes ?? []).slice(0, 40)) details.push(String(o));
    details.push(
      "ledger update: " +
        `${d.quotes_added || 0} quote(s), ` +
        `${d.concepts_changed || 0} concept change(s), ` +
        `crux ${d.crux_changed ? "changed" : "unchanged"}, ` +
        `story ${d.story_changed ? "changed" : "unchanged"}, ` +
        `open questions ${d.host_guide_changed ? "changed" : "unchanged"}, ` +
        `board ${d.board_changed ? "changed" : "unchanged"}`,
    );
    if (d.concepts_removed.length)
      details.push(`concept removals: ${d.concepts_removed.join(", ")}`);
    if (d.rejections.length) details.push(`rejections: ${d.rejections.slice(0, 12).join(" | ")}`);
  }
  return details.length ? details.join("; ") : null;
}

// ── model calls ─────────────────────────────────────────────────────

export function jsonFromModelText(text: string): Json {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  const parsed: unknown = JSON.parse(cleaned);
  if (!isRecord(parsed)) throw new Error("Canvas extraction response was not a JSON object");
  return parsed;
}

function conversationChunks(conv: Json): Json[] {
  const chunks = list(conv.chunks);
  if (chunks.length) return chunks.filter(isRecord);
  return [{ id: null, transcript: conv.latest_transcript || "", created_at: conv.created_at }];
}

function transcriptPayloadForModel(bundle: Json): Json[] {
  const out: Json[] = [];
  let remaining = Math.max(12_000, 28_000);
  for (const conv of list(bundle.conversations)) {
    if (!isRecord(conv) || remaining <= 0) break;
    let chunks = list(conv.chunks);
    if (!chunks.length)
      chunks = [
        { id: null, transcript: conv.latest_transcript || "", created_at: conv.created_at },
      ];
    const payload: Json[] = [];
    for (const chunk of chunks) {
      if (!isRecord(chunk) || remaining <= 0) break;
      const transcript = orStr(chunk.transcript).trim();
      if (!transcript) continue;
      const clipped = transcript.slice(0, remaining);
      remaining -= clipped.length;
      payload.push({
        chunk_id: chunk.id ?? null,
        created_at: truthy(chunk.created_at) ? chunk.created_at : (chunk.timestamp ?? null),
        transcript: clipped,
      });
    }
    if (payload.length)
      out.push({ conversation_id: conv.id ?? null, who: conv.label ?? null, chunks: payload });
  }
  return out;
}

/** Python json.dumps(..., indent=2): the prompt text the model has always read. */
function dumps(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

export async function extractLivingCanvasUpdate(
  completer: Completer,
  args: { bundle: Json; state: CanvasState; reportName: string; brief: string },
): Promise<Json> {
  const project = dict(args.bundle.project);
  const payload = {
    report: { name: args.reportName },
    brief: args.brief,
    purpose_instruction: PURPOSE_INSTRUCTION,
    project: {
      name: project.name ?? null,
      language: truthy(project.language) ? project.language : "en",
      context: truthy(project.context) ? project.context : "",
      anonymize_transcripts: project.anonymize_transcripts ?? null,
    },
    enabled_tabs: normalizeCanvasTabs(args.state.tabs),
    current_ledgers: ledgerPromptSummary(args.state),
    new_transcript: transcriptPayloadForModel(args.bundle),
  };
  const res = await completer.complete({
    group: "multi_modal_fast",
    system: MODEL_EXTRACTION_SYSTEM_PROMPT,
    user: dumps(payload),
    temperature: 0.1,
    maxTokens: 8000,
  });
  return jsonFromModelText(res.text);
}

function ledgerAttribution(state: CanvasState): Json {
  const byConversation: Record<string, number> = {};
  const byVoice: Record<string, number> = {};
  for (const quote of freshCanvasState(state).quotes_ledger) {
    const src = dict(quote.source);
    const conv = orStr(src.conversation_id, "unknown");
    byConversation[conv] = (byConversation[conv] ?? 0) + 1;
    const voice = orStr(quote.who, "participant");
    byVoice[voice] = (byVoice[voice] ?? 0) + 1;
  }
  return { by_conversation: byConversation, by_voice: byVoice };
}

export async function generateHostGuide(
  completer: Completer,
  args: { reportName: string; brief: string; state: CanvasState; recent: Json; now: Date },
): Promise<Json> {
  const res = await completer.complete({
    group: "multi_modal_fast",
    system: HOST_GUIDE_SYSTEM_PROMPT,
    user: dumps({
      report: { name: args.reportName },
      brief: args.brief,
      current_ledgers: ledgerPromptSummary(args.state),
      ledger_attribution: ledgerAttribution(args.state),
      recent_run_activity: args.recent,
    }),
    temperature: 0.2,
    maxTokens: 1400,
  });
  const parsed = jsonFromModelText(res.text);
  const clean = (v: unknown, n: number) =>
    list(v)
      .map((x) => pyStr(x).trim())
      .filter(Boolean)
      .map((x) => pySlice(x, 220))
      .slice(0, n);
  return {
    where_the_room_is: pySlice(orStr(parsed.where_the_room_is).trim(), 900),
    what_to_ask_next: clean(parsed.what_to_ask_next, 3),
    under_heard: clean(parsed.under_heard, 5),
    updated_at: iso(args.now),
  };
}

function singleConversationBundle(bundle: Json, conversation: Json): Json {
  return {
    ...bundle,
    conversations: [conversation],
    counts: { ...dict(bundle.counts), conversations_with_recent_content: 1 },
  };
}

function shortId(v: unknown): string {
  const text = orStr(v, "unknown");
  return text.length > 8 ? text.slice(0, 8) : text;
}

export function windowedConversationBundles(
  bundle: Json,
  conversation: Json,
  windowChars = CANVAS_TRANSCRIPT_WINDOW_CHARS,
): Json[] {
  const size = Math.max(1000, windowChars);
  const bundles: Json[] = [];
  let current: Json[] = [];
  let currentSize = 0;
  const flush = () => {
    if (!current.length) return;
    const transcript = current.map((c) => orStr(c.transcript)).join("\n");
    bundles.push(
      singleConversationBundle(bundle, {
        ...conversation,
        chunks: current,
        latest_transcript: transcript,
      }),
    );
    current = [];
    currentSize = 0;
  };
  for (const chunk of conversationChunks(conversation)) {
    const transcript = orStr(chunk.transcript);
    if (!transcript.trim()) continue;
    let start = 0;
    while (start < transcript.length) {
      let room = size - currentSize;
      if (room <= 0) {
        flush();
        room = size;
      }
      const piece = transcript.slice(start, start + room);
      start += piece.length;
      if (!piece) break;
      current.push({ ...chunk, transcript: piece });
      currentSize += piece.length;
      if (currentSize >= size) flush();
    }
  }
  flush();
  return bundles;
}

function emptyDetail(): ExtractionDetail {
  return {
    quotes_added: 0,
    concepts_changed: 0,
    crux_changed: false,
    story_changed: false,
    host_guide_changed: false,
    board_changed: false,
    concepts_removed: [],
    rejections: [],
    conversation_outcomes: [],
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Every bundle's extraction merged into the ledgers, then the Open questions refreshed. */
export async function mergeExtractionForTick(
  completer: Completer,
  args: {
    bundle: Json;
    state: CanvasState;
    backfill: boolean;
    reportName: string;
    brief: string;
    now: Date;
  },
): Promise<[CanvasState, ExtractionDetail]> {
  let state = freshCanvasState(args.state);
  const combined = emptyDetail();
  const outcomes = combined.conversation_outcomes as string[];
  const conversations = list(args.bundle.conversations).filter(
    (c) => isRecord(c) && gatherHasTranscript({ conversations: [c] }),
  );
  if (args.backfill) combined.backfill_conversations = conversations.length;
  if (!conversations.length) return [state, combined];

  const bundles: [Json, string, number | null, number][] = [];
  const windowed = () => {
    for (const conv of conversations) {
      const windows = windowedConversationBundles(args.bundle, conv);
      windows.forEach((b, i) => {
        bundles.push([b, orStr(conv.id, "unknown"), i + 1, windows.length]);
      });
    }
  };
  if (args.backfill) windowed();
  else {
    const oversized = conversations.some(
      (conv) =>
        conversationChunks(conv).reduce((n, c) => n + orStr(c.transcript).length, 0) >
        CANVAS_TRANSCRIPT_WINDOW_CHARS,
    );
    if (oversized) windowed();
    else bundles.push([args.bundle, "recent", null, 1]);
  }

  for (const [bundle, convId, windowIndex, windowCount] of bundles) {
    let label = args.backfill ? `backfill conv ${shortId(convId)}` : `conv ${shortId(convId)}`;
    if (windowIndex !== null && windowCount > 1) label += ` window ${windowIndex}`;
    let extraction: Json;
    try {
      extraction = await extractLivingCanvasUpdate(completer, {
        bundle,
        state,
        reportName: args.reportName,
        brief: args.brief,
      });
    } catch (err) {
      outcomes.push(`${label}: model error: ${errorText(err)}`);
      continue;
    }
    const [next, detail] = applyModelExtraction(state, bundle, extraction);
    state = next;
    outcomes.push(
      `${label}: ${detail.quotes_added || 0} accepted / ${detail.rejections.length} rejected`,
    );
    combined.quotes_added += detail.quotes_added || 0;
    combined.concepts_changed += detail.concepts_changed || 0;
    combined.crux_changed = combined.crux_changed || detail.crux_changed;
    combined.story_changed = combined.story_changed || detail.story_changed;
    combined.board_changed = combined.board_changed || detail.board_changed;
    combined.concepts_removed.push(...detail.concepts_removed);
    combined.rejections.push(...detail.rejections);
  }
  try {
    const guide = await generateHostGuide(completer, {
      reportName: args.reportName,
      brief: args.brief,
      state,
      recent: combined as unknown as Json,
      now: args.now,
    });
    if (JSON.stringify(guide) !== JSON.stringify(state.host_guide)) {
      state.host_guide = guide;
      combined.host_guide_changed = true;
    }
  } catch (err) {
    combined.rejections.push(`open questions model error: ${errorText(err)}`);
  }
  return [state, combined];
}

function stateIsEmptyWall(state: CanvasState): boolean {
  const s = freshCanvasState(state);
  return (
    !s.quotes_ledger.length &&
    !s.concepts_ledger.length &&
    !s.board_cards.length &&
    !s.host_items.some((i) => !truthy(i.removed_at))
  );
}

function shapeWarnings(brief: string, tabs: Tab[]): string[] {
  const n = brief.toLowerCase();
  const warnings: string[] = [];
  const perPerson = [
    "person-by-person",
    "person by person",
    "per-person",
    "per person",
    "summary person",
    "each person",
  ].some((p) => n.includes(p));
  if (perPerson && !hasBoardTab(tabs))
    warnings.push(
      "brief asks for person-by-person; no tab primitive supports it in the current tab set",
    );
  for (const phrase of ["timeline", "calendar"]) {
    if (n.includes(phrase)) {
      warnings.push(`brief asks for ${phrase}; no tab primitive supports it`);
      break;
    }
  }
  return warnings;
}

/** The rendered wall: the ledgers plus the Audit tab's history, rendered in code. */
export async function renderWall(
  store: CanvasStore,
  args: { state: CanvasState; bundle: Json; reportName: string; reportId: string | null },
): Promise<string> {
  const state: CanvasState = args.reportId
    ? { ...args.state, audit_entries: await buildCanvasHistory(store, args.reportId, 30) }
    : args.state;
  return renderTabbedCanvas({
    state,
    project: dict(args.bundle.project),
    sampleNotice: (args.bundle.sample_notice as string | null) ?? null,
    reportName: args.reportName,
  });
}

// ── the tick, in phases ─────────────────────────────────────────────

export type TickOutcome = "ok" | "no_op" | "disabled" | "expired" | "duplicate" | "error";

/** What the phases hand each other; serialisable so the workflow checkpoints it. */
export interface TickPlan {
  readonly loopId: string;
  readonly tickKind: string;
  readonly startedAt: string;
  readonly loop: Json;
  readonly reportId: string | null;
  readonly projectId: string | null;
  readonly actingUser: string;
}

export interface Gathered {
  readonly config: Json;
  readonly latestOk: Json | null;
  readonly state: CanvasState;
  readonly structureChanged: boolean;
  readonly coldStart: boolean;
  readonly bundle: Json;
}

export async function createRun(
  d: TickDeps,
  args: {
    label: string;
    loopId: string;
    status: string;
    startedAt: string;
    detail?: string | null;
    generationId?: string | null;
  },
) {
  return d.store.insertRun({
    id: d.idFor(`run:${args.label}`),
    loopId: args.loopId,
    status: args.status,
    detail: args.detail ?? null,
    generationId: args.generationId ?? null,
    startedAt: args.startedAt,
    finishedAt: iso(d.now()),
  });
}

async function canvasEnabledForLoop(d: TickDeps, loop: Json): Promise<boolean> {
  if (!d.canvasEnabled) return false;
  const projectId = asId(loop.project_id);
  if (!projectId) return false;
  const project = await d.store.project(projectId);
  return Boolean(project && truthy(project.is_canvas_enabled));
}

/** Phase one: the loop may tick at all. Writes a no-op run and ends the tick when not. */
export async function prepareTick(
  d: TickDeps,
  loopId: string,
  tickKind: string,
): Promise<{ outcome: TickOutcome } | { outcome: "continue"; plan: TickPlan }> {
  const started = d.now();
  const startedAt = iso(started);
  const loop = await d.store.loop(loopId);
  if (!loop) throw new Error("Canvas loop not found");
  const noOp = async (detail: string, outcome: TickOutcome) => {
    await createRun(d, { label: "prepare", loopId, status: "no_op", detail, startedAt });
    return { outcome };
  };
  if (isPopcornLoop(loop)) return noOp("Not a canvas loop", "no_op");
  if (!(await canvasEnabledForLoop(d, loop)))
    return noOp("Canvas is disabled for this project", "disabled");
  const expires = parseDt(loop.expires_at);
  if (expires && started >= expires) {
    await d.store.updateLoop(loopId, { status: "expired" }, iso(d.now()));
    return noOp("Loop expired before tick start", "expired");
  }
  if (loop.status !== "active" && tickKind !== "manual")
    return noOp(`Loop is ${pyStr(loop.status ?? null)}`, "no_op");
  if (tickKind === "scheduled") {
    const cadence = Math.max(2, Number(loop.cadence_minutes) || 5);
    const window = Math.floor(Math.floor(started.getTime() / 1000) / (cadence * 60));
    if (!(await d.claimWindow(loopId, window, Math.max(30, cadence * 60 - 5))))
      return noOp("Duplicate tick for cadence window", "duplicate");
  }
  return {
    outcome: "continue",
    plan: {
      loopId,
      tickKind,
      startedAt,
      loop,
      reportId: asId(loop.report_id),
      projectId: asId(loop.project_id),
      actingUser: orStr(loop.acting_directus_user_id),
    },
  };
}

/** Phase two: read the config and the recent transcript as the loop's acting user. */
export async function gatherTick(d: TickDeps, plan: TickPlan): Promise<Gathered> {
  if (!plan.reportId || !plan.projectId || !plan.actingUser)
    throw new Error("Canvas loop is missing required ids");
  const config = await d.store.latestConfig(plan.reportId);
  if (!config) throw new Error("Canvas config revision not found");
  const latestOk = await d.store.latestOkGeneration(plan.reportId);
  const state = freshCanvasState(plan.loop);
  const tabs = normalizeCanvasTabs(config.tabs);
  const structureChanged = !tabsEqual(tabs, normalizeCanvasTabs(state.tabs));
  state.tabs = tabs;
  const coldStart = !state.quotes_ledger.length;
  const bundle = await executeGatherSpec(d, {
    projectId: plan.projectId,
    actingUser: plan.actingUser,
    gatherSpec: isRecord(config.gather_spec) ? config.gather_spec : {},
    fullHistory: coldStart,
    now: d.now(),
  });
  return {
    config,
    latestOk: latestOk ? { ...latestOk, created_at: directusTime(latestOk.created_at) } : null,
    state,
    structureChanged,
    coldStart,
    bundle,
  };
}

/** Nothing new since the last good generation and nothing forces a redraw. */
export function nothingNew(plan: TickPlan, g: Gathered): boolean {
  const latestContent = parseDt(g.bundle.latest_content_at);
  const latestGen = parseDt(g.latestOk?.created_at);
  return (
    !g.coldStart &&
    !g.structureChanged &&
    plan.tickKind !== "manual" &&
    g.latestOk !== null &&
    (!latestContent || (latestGen !== null && latestContent <= latestGen))
  );
}

function reportName(plan: TickPlan, config: Json, withBrief: boolean): string {
  return (
    orStr(plan.loop.name) ||
    orStr(config.name) ||
    (withBrief ? orStr(config.brief) : "") ||
    "Canvas"
  );
}

/** Phase three: the model calls. Reads only, so a replay after a crash is safe. */
export async function extractTick(
  d: TickDeps,
  plan: TickPlan,
  g: Gathered,
): Promise<{ failed: string } | { state: CanvasState; detail: ExtractionDetail }> {
  const brief = orStr(g.config.brief);
  if (gatherHasTranscript(g.bundle)) {
    try {
      const [state, detail] = await mergeExtractionForTick(d.completer, {
        bundle: g.bundle,
        state: g.state,
        backfill: g.coldStart,
        reportName: reportName(plan, g.config, true),
        brief,
        now: d.now(),
      });
      return { state, detail };
    } catch (err) {
      return { failed: `Model extraction failed: ${errorText(err)}` };
    }
  }
  const detail = emptyDetail();
  if (g.coldStart) detail.backfill_conversations = 0;
  const state = g.state;
  try {
    const guide = await generateHostGuide(d.completer, {
      reportName: reportName(plan, g.config, false),
      brief,
      state,
      recent: detail as unknown as Json,
      now: d.now(),
    });
    if (JSON.stringify(guide) !== JSON.stringify(state.host_guide)) {
      state.host_guide = guide;
      detail.host_guide_changed = true;
    }
  } catch (err) {
    detail.rejections.push(`open questions model error: ${errorText(err)}`);
  }
  return { state, detail };
}

/** Phase four: save the ledgers, render, sanitise and store the generation. */
export async function storeTick(
  d: TickDeps,
  plan: TickPlan,
  g: Gathered,
  extracted: { state: CanvasState; detail: ExtractionDetail },
): Promise<TickOutcome> {
  const state = extracted.state;
  const detail = extracted.detail;
  if (seedBoardCardsFromQuotes(state, plan.startedAt)) detail.board_changed = true;
  detail.rejections.push(...shapeWarnings(orStr(g.config.brief), state.tabs));
  if (
    stateIsEmptyWall(state) &&
    truthy(orStr(g.latestOk?.content_html).trim()) &&
    !g.structureChanged
  ) {
    await createRun(d, {
      label: "store",
      loopId: plan.loopId,
      status: "no_op",
      startedAt: plan.startedAt,
      detail: `Empty extraction would replace a contentful previous generation; ${pyStr(
        generationDetail({ strippedReferences: 0, bannedCopy: [], ledgerDetail: detail }),
      )}`,
    });
    return "no_op";
  }
  const reportId = plan.reportId as string;
  await d.store.updateLoop(plan.loopId, statePatch(state), iso(d.now()));
  const raw = await renderWall(d.store, {
    state,
    bundle: g.bundle,
    reportName: reportName(plan, g.config, false),
    reportId,
  });
  const sanitized = sanitizeCanvasHtml(raw, MAX_HTML_BYTES);
  const text = generationDetail({
    strippedReferences: sanitized.strippedReferences,
    bannedCopy: bannedVisibleCopy(sanitized.html),
    ledgerDetail: detail,
  });
  const generation = await d.store.insertGeneration({
    id: d.idFor("generation"),
    reportId,
    configRevisionId: asId(g.config.id),
    html: sanitized.html,
    status: "ok",
    tickKind: plan.tickKind,
    detail: text,
    now: iso(d.now()),
  });
  await createRun(d, {
    label: "store",
    loopId: plan.loopId,
    status: "ok",
    startedAt: plan.startedAt,
    detail: text,
    generationId: pyStr(generation.id),
  });
  await d.store.updateLoop(plan.loopId, { failure_count: 0 }, iso(d.now()));
  await d.nudge(reportId);
  return "ok";
}

/** A tick that failed after it started: an error generation and run, and a failure count. */
export async function failTick(
  d: TickDeps,
  plan: TickPlan,
  configId: string | null,
  detailRaw: string,
): Promise<void> {
  const detail = detailRaw.slice(0, 5000);
  let generationId: string | null = null;
  if (plan.reportId) {
    const generation = await d.store.insertGeneration({
      id: d.idFor("error-generation"),
      reportId: plan.reportId,
      configRevisionId: configId,
      html: "",
      status: "error",
      tickKind: plan.tickKind,
      detail,
      now: iso(d.now()),
    });
    generationId = pyStr(generation.id);
  }
  await createRun(d, {
    label: "error",
    loopId: plan.loopId,
    status: "error",
    startedAt: plan.startedAt,
    detail,
    generationId,
  });
  const failures = (Number(plan.loop.failure_count) || 0) + 1;
  const patch: Json = { failure_count: failures };
  if (failures >= 3) patch.status = "paused";
  await d.store.updateLoop(plan.loopId, patch, iso(d.now()));
}

/** Schedules the loop's next tick while it is active and before it expires. */
export async function enqueueNextIfDue(
  d: TickDeps,
  loopId: string,
  when: Date | null = null,
  taskId?: string,
): Promise<void> {
  const fresh = await d.store.loop(loopId);
  if (fresh?.status !== "active") return;
  const expires = parseDt(fresh.expires_at);
  const now = d.now();
  if (expires && now >= expires) {
    await d.store.updateLoop(loopId, { status: "expired" }, iso(now));
    return;
  }
  const cadence = Math.max(2, Number(fresh.cadence_minutes) || 5);
  let next = when ?? new Date(now.getTime() + cadence * 60_000);
  if (expires && next >= expires) {
    const finalAt = new Date(expires.getTime() - 5000);
    if (finalAt > now) next = finalAt;
    else {
      await d.store.updateLoop(loopId, { status: "expired" }, iso(now));
      return;
    }
  }
  await d.store.scheduleTick({
    ...(taskId && { id: taskId }),
    loopId,
    tickKind: "scheduled",
    scheduledAt: iso(next),
    now: iso(now),
  });
}

/**
 * One whole tick in process, for tests and callers without a workflow. The workflow in
 * jobs.ts runs the same phases as checkpointed steps.
 */
export async function runTick(
  d: TickDeps,
  loopId: string,
  tickKind = "scheduled",
): Promise<TickOutcome> {
  const prepared = await prepareTick(d, loopId, tickKind);
  if (prepared.outcome !== "continue") return prepared.outcome;
  const plan = prepared.plan;
  let configId: string | null = null;
  try {
    const g = await gatherTick(d, plan);
    configId = asId(g.config.id);
    if (nothingNew(plan, g)) {
      await createRun(d, {
        label: "gather",
        loopId,
        status: "no_op",
        startedAt: plan.startedAt,
        detail: "No new gathered content since latest generation",
      });
      await enqueueNextIfDue(d, loopId, null, d.idFor("next"));
      return "no_op";
    }
    const extracted = await extractTick(d, plan, g);
    if ("failed" in extracted) {
      await createRun(d, {
        label: "extract",
        loopId,
        status: "no_op",
        startedAt: plan.startedAt,
        detail: extracted.failed,
      });
      await enqueueNextIfDue(d, loopId, null, d.idFor("next"));
      return "no_op";
    }
    const outcome = await storeTick(d, plan, g, extracted);
    await enqueueNextIfDue(d, loopId, null, d.idFor("next"));
    return outcome;
  } catch (err) {
    await failTick(d, plan, configId, errorText(err));
    await enqueueNextIfDue(d, loopId, null, d.idFor("next"));
    return "error";
  }
}

/** Backfills one pending scheduled tick for every active loop that has none. */
export async function reconcileMissingTicks(d: TickDeps): Promise<number> {
  if (!d.canvasEnabled) return 0;
  const now = d.now();
  const loops = (await d.store.activeLoops(iso(now))).filter((l) => !isPopcornLoop(l));
  if (!loops.length) return 0;
  const covered = new Set<string>();
  for (const task of await d.store.pendingTicks()) {
    const loopId = orStr(dict(task.payload).loop_id);
    if (!loopId) continue;
    if (task.status === "scheduled") covered.add(loopId);
    else if (task.status === "processing") {
      const claimed = parseDt(task.claimed_at);
      if (claimed && (now.getTime() - claimed.getTime()) / 1000 <= STALE_TICK_SECONDS)
        covered.add(loopId);
      else if (task.id)
        await d.store.failTask(
          pyStr(task.id),
          "Stale processing claim rescued by canvas reconciler",
          iso(now),
        );
    }
  }
  let enqueued = 0;
  for (const loop of loops) {
    const loopId = orStr(loop.id);
    if (!loopId || covered.has(loopId)) continue;
    await enqueueNextIfDue(d, loopId, now);
    enqueued++;
  }
  return enqueued;
}
