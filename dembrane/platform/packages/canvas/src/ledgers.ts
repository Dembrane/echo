import { createHash } from "node:crypto";
import { newId } from "@dembrane/core";
import { CANVAS_CSS } from "./canvas-css";
import {
  dict,
  escapeHtml,
  isRecord,
  type Json,
  list,
  normalizeWs,
  orStr,
  pyRound,
  pyStr,
  truthy,
  utcNowIso,
} from "./py";

/**
 * Additive ledger state and the tabbed canvas renderer. The ledgers (quotes, concepts,
 * crux, story, board, host items) live on the agent_loop row and only grow through
 * receipts found verbatim in transcripts; the HTML is rendered from them in code, never
 * written by the model, so a hallucinated quote cannot reach the wall.
 */

export const CANVAS_TAB_SET_V1 = [
  "crux",
  "concept_cloud",
  "story",
  "host_guide",
  "trace",
  "audit",
] as const;
const SUPPORTED_TAB_KINDS = [
  "crux",
  "concept_cloud",
  "story",
  "host_guide",
  "board",
  "trace",
  "audit",
] as const;
type TabKind = (typeof SUPPORTED_TAB_KINDS)[number];
const TAB_LABELS: Record<TabKind, string> = {
  crux: "Crux",
  concept_cloud: "Concept cloud",
  story: "Story",
  // Internal state keeps canvas_host_guide; only the visible label changed.
  host_guide: "Open questions",
  board: "Board",
  trace: "Trace",
  audit: "Audit log",
};

export interface Tab {
  kind: TabKind;
  grouping?: string;
}

export interface CanvasState {
  schema_version: number;
  tabs: Tab[];
  quotes_ledger: Json[];
  concepts_ledger: Json[];
  crux: Json;
  host_items: Json[];
  story_slides: Json[];
  host_guide: Json;
  board_cards: Json[];
  audit_entries: Json[];
}

/** The state carried by an agent_loop row (canvas_* columns) or an in-memory state. */
export function freshCanvasState(loop: Json | CanvasState | null | undefined = null): CanvasState {
  const l = (loop ?? {}) as Json;
  const pick = (a: string, b: string) => (truthy(l[a]) ? l[a] : l[b]);
  const crux = dict(pick("crux", "canvas_crux"));
  return {
    schema_version: 1,
    tabs: normalizeCanvasTabs(pick("tabs", "canvas_tabs")),
    quotes_ledger: list(pick("quotes_ledger", "canvas_quotes_ledger")),
    concepts_ledger: list(pick("concepts_ledger", "canvas_concepts_ledger")),
    crux: truthy(crux) ? crux : { question: "", history: [] },
    host_items: list(pick("host_items", "canvas_host_items")),
    story_slides: list(pick("story_slides", "canvas_story_slides")),
    host_guide: dict(pick("host_guide", "canvas_host_guide")),
    board_cards: list(pick("board_cards", "canvas_board_cards")),
    audit_entries: list(pick("audit_entries", "canvas_audit_entries")),
  };
}

/** The agent_loop columns a state is saved into. */
export function statePatch(state: CanvasState): Json {
  return {
    canvas_tabs: normalizeCanvasTabs(state.tabs),
    canvas_quotes_ledger: truthy(state.quotes_ledger) ? state.quotes_ledger : [],
    canvas_concepts_ledger: truthy(state.concepts_ledger) ? state.concepts_ledger : [],
    canvas_crux: truthy(state.crux) ? state.crux : { question: "", history: [] },
    canvas_host_items: truthy(state.host_items) ? state.host_items : [],
    canvas_story_slides: truthy(state.story_slides) ? state.story_slides : [],
    canvas_host_guide: truthy(state.host_guide) ? state.host_guide : {},
    canvas_board_cards: truthy(state.board_cards) ? state.board_cards : [],
  };
}

export function normalizeCanvasTabs(tabs: unknown): Tab[] {
  const source: unknown[] = Array.isArray(tabs) && tabs.length ? tabs : [...CANVAS_TAB_SET_V1];
  const out: Tab[] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const tab = normalizeTabConfig(raw);
    if (!tab) continue;
    const key = tabKey(tab);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tab);
  }
  if (!out.length) return CANVAS_TAB_SET_V1.map((kind) => ({ kind }));
  return out;
}

function normalizeTabConfig(raw: unknown): Tab | null {
  if (typeof raw === "string") {
    const kind = normalizeTabKind(raw);
    return kind ? { kind } : null;
  }
  if (!isRecord(raw)) return null;
  const kind = normalizeTabKind(raw.kind || raw.tab || raw.type);
  if (!kind) return null;
  const tab: Tab = { kind };
  if (kind === "board") {
    const grouping = orStr(raw.grouping, "person").trim().toLowerCase();
    tab.grouping = ["", "voice", "speaker"].includes(grouping) ? "person" : grouping;
  }
  return tab;
}

const TAB_ALIASES: Record<string, string> = {
  cloud: "concept_cloud",
  concept: "concept_cloud",
  concepts: "concept_cloud",
  concepts_cloud: "concept_cloud",
  host: "host_guide",
  guide: "host_guide",
  history: "audit",
  audit_log: "audit",
  log: "audit",
  person_board: "board",
  people: "board",
  per_person: "board",
};

function normalizeTabKind(value: unknown): TabKind | null {
  let n = orStr(value).trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  n = TAB_ALIASES[n] ?? n;
  return (SUPPORTED_TAB_KINDS as readonly string[]).includes(n) ? (n as TabKind) : null;
}

function _tabKind(tab: unknown): string {
  if (isRecord(tab)) return orStr(tab.kind);
  return orStr(tab);
}

function tabKey(tab: Tab): string {
  if (tab.kind === "board") return `board:${tab.grouping || "person"}`;
  return tab.kind;
}

export function hasBoardTab(stateOrTabs: unknown): boolean {
  const tabs = isRecord(stateOrTabs) ? stateOrTabs.tabs : stateOrTabs;
  return normalizeCanvasTabs(tabs).some((t) => t.kind === "board");
}

function tabsEqual(a: Tab[], b: Tab[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export { tabsEqual };

export function seedBoardCardsFromQuotes(state: CanvasState, now?: string): boolean {
  if (!hasBoardTab(state as unknown as Json) || truthy(state.board_cards)) return false;
  const at = now ?? utcNowIso();
  const byVoice = new Map<string, Json[]>();
  for (const quote of state.quotes_ledger) {
    const voice = orStr(quote.who).trim();
    if (!voice || voice.toLowerCase() === "participant") continue;
    byVoice.set(voice, [...(byVoice.get(voice) ?? []), quote]);
  }
  if (!byVoice.size) return false;
  for (const voice of [...byVoice.keys()].sort(pyCompare)) {
    const quotes = byVoice.get(voice) ?? [];
    const quoteIds = quotes.map((q) => orStr(q.id)).filter(Boolean);
    const latest = orStr(quotes.at(-1)?.quote).trim();
    if (!quoteIds.length || !latest) continue;
    state.board_cards.push({
      id: newId(),
      group: voice,
      grouping: "person",
      synthesis: pySlice(latest, 700),
      quote_ids: quoteIds.slice(-8),
      first_seen: at,
      updated_at: at,
    });
  }
  return state.board_cards.length > 0;
}

export class CanvasValueError extends Error {}

export interface ExtractionDetail {
  quotes_added: number;
  concepts_changed: number;
  crux_changed: boolean;
  story_changed: boolean;
  board_changed: boolean;
  host_guide_changed?: boolean;
  concepts_removed: string[];
  rejections: string[];
  conversation_outcomes?: string[];
  backfill_conversations?: number;
}

export function applyModelExtraction(
  stateIn: CanvasState,
  gather: Json,
  extraction: Json,
): [CanvasState, ExtractionDetail] {
  const state = freshCanvasState(stateIn);
  const now = utcNowIso();
  const index = transcriptIndex(gather);
  const [accepted, idx, qr] = acceptModelQuotes(state, extraction, index, now);
  const [conceptChanges, cr] = mergeModelConcepts(state, extraction, idx, now);
  const [cruxChanged, xr] = updateModelCrux(state, extraction, now);
  const [storyChanged, sr] = mergeStorySlides(state, extraction, idx, now);
  const [boardChanged, br] = mergeBoardCards(state, extraction, idx, now);
  return [
    state,
    {
      quotes_added: accepted,
      concepts_changed: conceptChanges,
      crux_changed: cruxChanged,
      story_changed: storyChanged,
      board_changed: boardChanged,
      concepts_removed: [],
      rejections: [...qr, ...cr, ...xr, ...sr, ...br],
    },
  ];
}

export function ledgerPromptSummary(stateIn: CanvasState | Json): Json {
  const state = freshCanvasState(stateIn as Json);
  const ranked = sortDesc(state.concepts_ledger, (c) => [
    conceptScore(c, state.quotes_ledger),
    orStr(c.last_reinforced),
  ]).slice(0, 24);
  return {
    concepts: ranked
      .filter((c) => truthy(c.phrase))
      .map((c) => ({ phrase: c.phrase ?? null, size_tier: c.size_tier ?? null })),
    crux: truthy(state.crux.question) ? state.crux.question : null,
    story_headings: state.story_slides
      .filter((s) => isRecord(s) && truthy(s.heading))
      .map((s) => s.heading)
      .slice(0, 8),
    board_groups: state.board_cards
      .filter((c) => isRecord(c) && truthy(c.group))
      .map((c) => c.group)
      .slice(0, 12),
  };
}

interface IndexedConversation {
  label: unknown;
  created_at: unknown;
  text: string;
  chunks: Map<string, { text: string; created_at: unknown }>;
}

function transcriptIndex(gather: Json): Map<string, IndexedConversation> {
  const index = new Map<string, IndexedConversation>();
  for (const conv of list(gather.conversations)) {
    const convId = orStr(conv.id);
    if (!convId) continue;
    let chunks = list(conv.chunks);
    if (!chunks.length)
      chunks = [
        { id: null, transcript: conv.latest_transcript || "", created_at: conv.created_at },
      ];
    const parts = chunks.map((c) => orStr(c.transcript));
    const map = new Map<string, { text: string; created_at: unknown }>();
    for (const c of chunks)
      map.set(orStr(c.id), {
        text: orStr(c.transcript),
        created_at: truthy(c.created_at) ? c.created_at : c.timestamp,
      });
    index.set(convId, {
      label: conv.label !== "participant" ? conv.label : null,
      created_at: conv.created_at,
      text: parts.filter(Boolean).join("\n"),
      chunks: map,
    });
  }
  return index;
}

function quoteSource(q: Json): Json {
  return dict(q.source);
}

function acceptModelQuotes(
  state: CanvasState,
  extraction: Json,
  index: Map<string, IndexedConversation>,
  now: string,
): [number, Map<number, string>, string[]] {
  const seen = new Set(
    state.quotes_ledger.map((q) =>
      JSON.stringify([
        orStr(quoteSource(q).conversation_id),
        orStr(quoteSource(q).chunk_id),
        orStr(q.quote).trim(),
      ]),
    ),
  );
  let appended = 0;
  const idx = new Map<number, string>();
  const rejections: string[] = [];
  list(extraction.quotes).forEach((quote, modelIndex) => {
    const text = orStr(quote.quote).trim();
    const convId = orStr(quote.conversation_id);
    const chunkId = truthy(quote.chunk_id) ? pyStr(quote.chunk_id) : "";
    const conv = index.get(convId);
    if (!text || !conv) {
      rejections.push(`quote[${modelIndex}] missing text or conversation: ${pySlice(text, 80)}`);
      return;
    }
    if (!normalizeWs(conv.text).includes(normalizeWs(text))) {
      rejections.push(`quote[${modelIndex}] not found verbatim: ${pySlice(text, 120)}`);
      return;
    }
    const key = JSON.stringify([convId, chunkId, text]);
    const existing = existingQuoteId(state, convId, chunkId, text);
    if (existing) {
      idx.set(modelIndex, existing);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = conv.chunks.get(chunkId);
    const id = newId();
    idx.set(modelIndex, id);
    state.quotes_ledger.push({
      id,
      who: truthy(quote.who) ? quote.who : conv.label,
      quote: text,
      source: { conversation_id: convId, chunk_id: chunkId || null },
      when: truthy(chunk?.created_at)
        ? chunk?.created_at
        : truthy(conv.created_at)
          ? conv.created_at
          : now,
    });
    appended++;
  });
  return [appended, idx, rejections];
}

function mergeModelConcepts(
  state: CanvasState,
  extraction: Json,
  idx: Map<number, string>,
  now: string,
): [number, string[]] {
  let changed = collapseNearDuplicateConcepts(state, now);
  const byPhrase = conceptLookup(state);
  const rejections: string[] = [];
  const quotesById = new Map(state.quotes_ledger.map((q) => [pyStr(q.id), q]));
  list(extraction.concepts).forEach((input, modelIndex) => {
    const phrase = orStr(input.phrase).trim();
    if (!phrase) {
      rejections.push(`concept[${modelIndex}] empty phrase`);
      return;
    }
    const quoteIds = supportedQuoteIds(input.supporting_quote_indices, idx);
    if (!quoteIds.length) {
      rejections.push(
        `concept[${modelIndex}] has no accepted supporting quote: ${pySlice(phrase, 80)}`,
      );
      return;
    }
    const inQuote = quoteIds.some((qid) => {
      const q = quotesById.get(qid);
      return q ? normalizeWs(orStr(q.quote)).includes(normalizeWs(phrase)) : false;
    });
    if (!inQuote) {
      rejections.push(
        `concept[${modelIndex}] phrase not found in supporting quote: ${pySlice(phrase, 80)}`,
      );
      return;
    }
    const key = conceptPhraseKey(phrase);
    let concept = findNearDuplicateConcept(byPhrase, key);
    if (!concept) {
      concept = {
        id: newId(),
        phrase,
        quote_ids: [],
        size_tier: "s",
        first_seen: now,
        last_reinforced: now,
      };
      state.concepts_ledger.push(concept);
      byPhrase.set(key, concept);
      changed++;
    } else if (preferConceptPhrase(phrase, orStr(concept.phrase))) {
      concept.phrase = phrase;
      concept.last_reinforced = now;
      changed++;
    }
    const ids = concept.quote_ids as string[];
    for (const qid of quoteIds) {
      if (ids.includes(qid)) continue;
      ids.push(qid);
      concept.last_reinforced = now;
      changed++;
    }
  });
  changed += collapseNearDuplicateConcepts(state, now);
  const ranked = sortDesc(state.concepts_ledger, (c) => [
    conceptScore(c, state.quotes_ledger),
    orStr(c.first_seen),
  ]);
  ranked.forEach((concept, i) => {
    const old = concept.size_tier;
    const tier = i < 3 && ranked.length >= 3 ? "xl" : i < 7 ? "l" : i < 13 ? "m" : "s";
    if (old !== tier) {
      concept.size_tier = tier;
      changed++;
    }
  });
  return [changed, rejections];
}

function conceptLookup(state: CanvasState): Map<string, Json> {
  const m = new Map<string, Json>();
  for (const c of state.concepts_ledger)
    if (truthy(c.phrase)) m.set(conceptPhraseKey(orStr(c.phrase)), c);
  return m;
}

const FILLER = new Set(["a", "again", "an", "and", "of", "the", "to", "with"]);

function conceptPhraseKey(phrase: string): string {
  const words = phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.filter((w) => !FILLER.has(w)).join(" ");
}

function findNearDuplicateConcept(byPhrase: Map<string, Json>, key: string): Json | null {
  if (!key) return null;
  const direct = byPhrase.get(key);
  if (direct) return direct;
  for (const [existing, concept] of byPhrase) {
    if (!existing) continue;
    if (keyContains(existing, key) || keyContains(key, existing)) return concept;
  }
  return null;
}

function keyContains(haystack: string, needle: string): boolean {
  const h = haystack.split(/\s+/).filter(Boolean);
  const n = needle.split(/\s+/).filter(Boolean);
  if (!h.length || !n.length || n.length > h.length) return false;
  for (let i = 0; i <= h.length - n.length; i++) if (n.every((w, j) => h[i + j] === w)) return true;
  return false;
}

function preferConceptPhrase(candidateRaw: string, currentRaw: string): boolean {
  const candidate = candidateRaw.trim();
  const current = currentRaw.trim();
  if (!candidate) return false;
  if (!current) return true;
  const cw = candidate.split(/\s+/).filter(Boolean).length;
  const uw = current.split(/\s+/).filter(Boolean).length;
  return cw > uw || (cw === uw && candidate.length > current.length);
}

function collapseNearDuplicateConcepts(state: CanvasState, now: string): number {
  const concepts = state.concepts_ledger.filter(isRecord);
  const merged: Json[] = [];
  let changed = 0;
  for (const concept of concepts) {
    const phrase = orStr(concept.phrase).trim();
    const key = conceptPhraseKey(phrase);
    const lookup = new Map<string, Json>();
    for (const item of merged) lookup.set(conceptPhraseKey(orStr(item.phrase)), item);
    const existing = findNearDuplicateConcept(lookup, key);
    if (!existing) {
      merged.push(concept);
      continue;
    }
    if (preferConceptPhrase(phrase, orStr(existing.phrase))) existing.phrase = phrase;
    const pooled = list(existing.quote_ids).map((q) => pyStr(q));
    for (const qid of list(concept.quote_ids).map((q) => pyStr(q)))
      if (!pooled.includes(qid)) pooled.push(qid);
    existing.quote_ids = pooled;
    existing.last_reinforced = now;
    changed++;
  }
  if (merged.length !== state.concepts_ledger.length) state.concepts_ledger = merged;
  return changed;
}

function updateModelCrux(state: CanvasState, extraction: Json, now: string): [boolean, string[]] {
  const input = extraction.crux;
  if (input === null || input === undefined) return [false, []];
  if (!isRecord(input)) return [false, ["crux was not an object or null"]];
  const question = orStr(input.question).trim();
  if (!question) return [false, ["crux question was empty"]];
  if ([...question].length > 180) return [false, ["crux question was over 180 characters"]];
  const current = orStr(state.crux.question).trim();
  if (question === current) return [false, []];
  const crux = state.crux;
  if (current) {
    if (!Array.isArray(crux.history)) crux.history = [];
    (crux.history as Json[]).push({ question: current, replaced_at: now });
  }
  crux.question = question;
  crux.updated_at = now;
  return [true, []];
}

function mergeStorySlides(
  state: CanvasState,
  extraction: Json,
  idx: Map<number, string>,
  now: string,
): [boolean, string[]] {
  const slides = list(extraction.story_slides);
  if (!slides.length) return [false, []];
  const accepted: Json[] = [];
  const rejections: string[] = [];
  slides.slice(0, 8).forEach((slide, i) => {
    const heading = orStr(slide.heading).trim();
    if (!heading) {
      rejections.push(`story_slides[${i}] empty heading`);
      return;
    }
    accepted.push({
      id: truthy(slide.id) ? pyStr(slide.id) : newId(),
      eyebrow: orStr(slide.eyebrow).trim() || null,
      heading: pySlice(heading, 180),
      lede: pySlice(orStr(slide.lede).trim(), 600),
      quote_ids: supportedQuoteIds(slide.quote_indices, idx),
      updated_at: now,
    });
  });
  if (!accepted.length) return [false, rejections];
  state.story_slides = accepted;
  return [true, rejections];
}

function mergeBoardCards(
  state: CanvasState,
  extraction: Json,
  idx: Map<number, string>,
  now: string,
): [boolean, string[]] {
  if (!hasBoardTab(state as unknown as Json)) return [false, []];
  const cards = list(extraction.board_cards);
  if (!cards.length) return [seedBoardCardsFromQuotes(state, now), []];
  const quotesById = new Map(state.quotes_ledger.map((q) => [pyStr(q.id), q]));
  const byGroup = new Map<string, Json>();
  for (const card of state.board_cards)
    if (truthy(card.group)) byGroup.set(orStr(card.group).trim().toLowerCase(), card);
  let changed = false;
  const rejections: string[] = [];
  cards.slice(0, 24).forEach((input, i) => {
    const quoteIds = supportedQuoteIds(input.quote_indices, idx);
    const evidence = quoteIds.map((q) => quotesById.get(q)).filter((q): q is Json => !!q);
    if (!evidence.length) {
      rejections.push(`board_cards[${i}] has no accepted receipt quote`);
      return;
    }
    const group = boardGroupForQuotes(evidence);
    const synthesis = orStr(input.synthesis).trim();
    if (!synthesis) {
      rejections.push(`board_cards[${i}] empty synthesis for ${group}`);
      return;
    }
    const key = group.toLowerCase();
    let card = byGroup.get(key);
    if (!card) {
      card = {
        id: newId(),
        group,
        grouping: "person",
        synthesis: "",
        quote_ids: [],
        first_seen: now,
        updated_at: now,
      };
      state.board_cards.push(card);
      byGroup.set(key, card);
      changed = true;
    }
    const clipped = pySlice(synthesis, 700);
    if (card.synthesis !== clipped) {
      card.synthesis = clipped;
      card.updated_at = now;
      changed = true;
    }
    const current = list(card.quote_ids).map((q) => pyStr(q));
    for (const qid of quoteIds)
      if (!current.includes(qid)) {
        current.push(qid);
        changed = true;
      }
    card.quote_ids = current.slice(-8);
  });
  return [changed, rejections];
}

function boardGroupForQuotes(quotes: Json[]): string {
  const voices = new Set(
    quotes.map((q) => orStr(q.who).trim()).filter((v) => v && v.toLowerCase() !== "participant"),
  );
  if (voices.size === 1) return [...voices][0] as string;
  return "the room";
}

// ── rendering ─────────────────────────────────────────────────────────

export function renderTabbedCanvas(args: {
  state: CanvasState;
  project: Json;
  sampleNotice?: string | null;
  reportName?: string | null;
}): string {
  const state = freshCanvasState(args.state);
  let tabs = normalizeCanvasTabs(state.tabs);
  if (!tabs.length) tabs = normalizeCanvasTabs([...CANVAS_TAB_SET_V1]);
  const projectName = escapeHtml(orStr(args.project.name, "Canvas"));
  const sample = args.sampleNotice
    ? `<p class="tabbed-canvas-notice">${escapeHtml(args.sampleNotice)}</p>`
    : "";
  const controls = tabs
    .map(
      (tab, i) =>
        `<input class="tabbed-canvas-radio" type="radio" name="canvas-tab" id="canvas-tab-${tabDomId(tab)}" ${i === 0 ? "checked" : ""}>`,
    )
    .join("\n");
  const labels = tabs
    .map(
      (tab) =>
        `<label class="tabbed-canvas-tab tabbed-canvas-tab-fallback" for="canvas-tab-${tabDomId(tab)}">${escapeHtml(TAB_LABELS[tab.kind])}</label>` +
        `<a class="tabbed-canvas-tab tabbed-canvas-tab-link" href="#tab-${tabDomId(tab)}">${escapeHtml(TAB_LABELS[tab.kind])}</a>`,
    )
    .join("\n");
  const panels = tabs.map((tab) => panel(tab, state)).join("\n");
  const href = newTabChatHref(args.project, args.reportName ?? null);
  return `
<div class="canvas-shell tabbed-canvas" data-canvas-schema="tabbed-v1">
  <style>${CANVAS_CSS}</style>
  <div class="tabbed-canvas-frame">
    <p class="tabbed-canvas-kicker">${projectName}</p>
    ${sample}
    ${controls}
    <nav class="tabbed-canvas-tabbar" aria-label="Canvas tabs">
      ${labels}
      <a class="tabbed-canvas-add" href="${href}" target="_top" aria-label="Open a chat to request a new tab">+</a>
    </nav>
    ${panels}
  </div>
</div>
`.trim();
}

function panel(tab: Tab, state: CanvasState): string {
  const kind = tab.kind;
  const label = escapeHtml(TAB_LABELS[kind]);
  let body: string;
  if (kind === "crux") body = renderCrux(state);
  else if (kind === "concept_cloud") body = renderCloud(state);
  else if (kind === "host_guide") body = renderHostGuide(state);
  else if (kind === "board") body = renderBoard(state);
  else if (kind === "trace") body = renderTrace(state);
  else if (kind === "audit") body = renderAudit(state);
  else body = renderStory(state);
  const dom = tabDomId(tab);
  return `<section class="tabbed-canvas-panel tabbed-canvas-panel-${dom}" id="tab-${dom}" data-tab-panel="${dom}" aria-label="${label}">${body}</section>`;
}

function renderCrux(state: CanvasState): string {
  const question = escapeHtml(orStr(state.crux.question, "What should we listen for next?"));
  const host = renderHostItems(state, "crux");
  return `
<div class="tabbed-crux">
  <p class="tabbed-canvas-kicker">Crux</p>
  <h1>${question}</h1>
  <p class="tabbed-canvas-lede">Scan the room and give your first answer out loud: one move, one bet, one reason it works.</p>
  ${host}
</div>
`.trim();
}

function renderCloud(state: CanvasState): string {
  const concepts = orderedCloudConcepts(state.concepts_ledger).slice(0, 20);
  const tiles = concepts.length
    ? concepts.map((c, i) => conceptTile(c, state.quotes_ledger, i)).join("\n")
    : '<p class="tabbed-canvas-empty">Concepts will appear as transcript receipts arrive.</p>';
  return `<div class="tabbed-cloud">${tiles}${renderHostItems(state, "concept_cloud")}</div>`;
}

const TIER_RANK: Record<string, number> = { xl: 4, l: 3, m: 2, s: 1 };

function orderedCloudConcepts(concepts: Json[]): Json[] {
  const ranked = sortDesc(concepts, (c) => [
    TIER_RANK[pyStr(c.size_tier)] ?? 1,
    orStr(c.last_reinforced),
  ]).slice(0, 20);
  if (!ranked.length) return [];
  const xl = hashSorted(ranked.filter((c) => pyStr(c.size_tier) === "xl"));
  const others = hashSorted(ranked.filter((c) => pyStr(c.size_tier) !== "xl"));
  const ordered: (Json | null)[] = new Array(ranked.length).fill(null);
  if (xl.length && others.length) {
    xl.forEach((concept, i) => {
      let slot = pyRound((i * (ranked.length - 1)) / Math.max(1, xl.length - 1));
      while (slot < ordered.length && ordered[slot] !== null) slot++;
      if (slot >= ordered.length) slot = ordered.indexOf(null);
      ordered[slot] = concept;
    });
  } else {
    xl.forEach((c, i) => {
      ordered[i] = c;
    });
  }
  let k = 0;
  return ordered.map((item) => item ?? (others[k++] as Json));
}

function hashSorted(concepts: Json[]): Json[] {
  return [...concepts].sort(
    (a, b) =>
      stableHash(orStr(a.id) || orStr(a.phrase)) - stableHash(orStr(b.id) || orStr(b.phrase)),
  );
}

function renderStory(state: CanvasState): string {
  let slideHtml: string;
  if (state.story_slides.length) {
    slideHtml = state.story_slides.map((s) => storySlide(s, state.quotes_ledger)).join("\n");
  } else {
    const quotes = state.quotes_ledger.slice(-4);
    const inner = quotes.length
      ? quotes.map(quoteBlock).join("\n")
      : '<p class="tabbed-canvas-empty">The story is waiting for the first usable room quotes.</p>';
    const heading = escapeHtml(orStr(state.crux.question, "What is emerging?"));
    slideHtml = `
<article class="tabbed-story-slide">
  <p class="tabbed-canvas-kicker">Story</p>
  <h3>${heading}</h3>
  <div class="tabbed-story-evidence">${inner}</div>
</article>
`.trim();
  }
  return `
<div class="tabbed-story">
  <div class="tabbed-story-stack">${slideHtml}</div>
  ${renderHostItems(state, "story")}
</div>
`.trim();
}

function renderHostGuide(state: CanvasState): string {
  const guide = dict(state.host_guide);
  const where = orStr(guide.where_the_room_is).trim();
  const questions = list(guide.what_to_ask_next)
    .map((x) => pyStr(x).trim())
    .filter(Boolean)
    .slice(0, 3);
  const underHeard = list(guide.under_heard)
    .map((x) => pyStr(x).trim())
    .filter(Boolean)
    .slice(0, 5);
  let body: string;
  if (!where && !questions.length && !underHeard.length) {
    body =
      '<p class="tabbed-canvas-empty">Open questions are waiting for usable room receipts.</p>';
  } else {
    const whereHtml = where ? `<p class="tabbed-open-orient">${escapeHtml(where)}</p>` : "";
    const qHtml = questions.length
      ? `<section class="tabbed-guide-block"><h3>What to ask next</h3><ol>${questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ol></section>`
      : "";
    const uHtml = underHeard.length
      ? `<section class="tabbed-guide-block"><h3>Under-heard</h3><ul>${underHeard.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul></section>`
      : "";
    body = whereHtml + qHtml + uHtml;
  }
  return `
<div class="tabbed-host-guide">
  <p class="tabbed-canvas-kicker">Open questions</p>
  ${body}
</div>
`.trim();
}

function renderBoard(state: CanvasState): string {
  const body = state.board_cards.length
    ? state.board_cards
        .slice(0, 30)
        .map((c) => boardCard(c, state.quotes_ledger))
        .join("\n")
    : '<p class="tabbed-canvas-empty">No attributed voices yet.</p>';
  return `
<div class="tabbed-board">
  ${body}
</div>
`.trim();
}

function renderTrace(state: CanvasState): string {
  const entries = traceEntries(state);
  const byId = new Map(state.quotes_ledger.map((q) => [pyStr(q.id), q]));
  const body = entries.length
    ? entries.map((e) => traceEntry(e, byId)).join("\n")
    : '<p class="tabbed-canvas-empty">Trace cards appear when a visible claim has receipt quotes.</p>';
  return `
<div class="tabbed-trace-room">
  ${body}
</div>
`.trim();
}

function renderAudit(state: CanvasState): string {
  const entries = sortDesc(state.audit_entries.filter(isRecord), (e) => [orStr(e.at)]);
  const body = entries.length
    ? entries.slice(0, 30).map(auditEntry).join("\n")
    : '<p class="tabbed-canvas-empty">Audit log entries appear after the canvas runs or the host changes it.</p>';
  return `
<div class="tabbed-audit">
  ${body}
</div>
`.trim();
}

interface TraceEntry {
  id: string;
  label: string;
  claim: string;
  quote_ids: string[];
}

function traceEntries(state: CanvasState): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const seen = new Set<string>();
  for (const c of sortDesc(state.concepts_ledger, (x) => [orStr(x.last_reinforced)])) {
    const ids = list(c.quote_ids)
      .map((q) => pyStr(q))
      .filter((q) => q.trim());
    appendTrace(entries, seen, "Concept", orStr(c.phrase).trim(), ids);
  }
  for (const s of state.story_slides) {
    const ids = list(s.quote_ids)
      .map((q) => pyStr(q))
      .filter((q) => q.trim());
    appendTrace(entries, seen, "Story", orStr(s.lede || s.heading).trim(), ids);
  }
  for (const c of state.board_cards) {
    const ids = list(c.quote_ids)
      .map((q) => pyStr(q))
      .filter((q) => q.trim());
    appendTrace(entries, seen, "Board", orStr(c.synthesis || c.group).trim(), ids);
  }
  return entries;
}

function appendTrace(
  entries: TraceEntry[],
  seen: Set<string>,
  label: string,
  claim: string,
  idsIn: string[],
) {
  const ids = idsIn.filter((q, i) => q && !idsIn.slice(0, i).includes(q));
  if (!claim || !ids.length) return;
  const id = traceId(claim, ids);
  if (seen.has(id)) return;
  seen.add(id);
  entries.push({ id, label, claim, quote_ids: ids });
}

function sha1(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

function traceId(claim: string, ids: string[]): string {
  return `trace-${sha1([normalizeWs(claim), ...ids].join("|")).slice(0, 10)}`;
}

function traceEntry(entry: TraceEntry, byId: Map<string, Json>): string {
  const rows = entry.quote_ids
    .map((q) => byId.get(q))
    .filter((q): q is Json => !!q)
    .map(quoteBlock);
  const quotesHtml =
    rows.join("\n") ||
    '<p class="tabbed-canvas-empty">The receipt quotes for this claim are no longer available.</p>';
  return `
<article class="tabbed-trace-entry" id="${escapeHtml(entry.id)}">
  <p class="tabbed-canvas-kicker">${escapeHtml(entry.label || "Trace")}</p>
  <h2>${escapeHtml(entry.claim)}</h2>
  <div class="tabbed-trace-cards">${quotesHtml}</div>
</article>
`.trim();
}

// The audit summary separates outcome and cause with an em dash, as the Python renderer did.
const EM_DASH = "—";

function auditEntry(entry: Json): string {
  const at = escapeHtml(formatAuditTime(entry.at));
  const outcome = escapeHtml(orStr(entry.kind, "run").replaceAll("_", " "));
  const cause = formatAuditCause(entry.cause);
  const links = formatAuditLinks(entry);
  let summary = `${at} · ${outcome} ${EM_DASH} ${escapeHtml(cause)}`;
  if (links) summary = `${summary} · ${links}`;
  const heard = auditList("Heard", entry.heard);
  const changes = auditList("Added / updated", entry.changes);
  const keptOut = auditList("Kept out", entry.kept_out);
  const version = escapeHtml(orStr(entry.version, "unversioned"));
  return `
<details class="tabbed-audit-entry">
  <summary>${summary}</summary>
  <div class="tabbed-audit-body">
    ${heard}
    ${changes}
    ${keptOut}
    <p><b>Cause</b> ${escapeHtml(cause)}</p>
    <p><b>View version</b> ${version}</p>
  </div>
</details>
`.trim();
}

function auditList(label: string, value: unknown): string {
  const items = Array.isArray(value) ? value.map((x) => pyStr(x).trim()).filter(Boolean) : [];
  if (!items.length) return `<p><b>${escapeHtml(label)}</b> none</p>`;
  const rows = items
    .slice(0, 8)
    .map((i) => `<li>${escapeHtml(i)}</li>`)
    .join("");
  return `<section><b>${escapeHtml(label)}</b><ul>${rows}</ul></section>`;
}

function formatAuditTime(value: unknown): string {
  const raw = orStr(value).trim();
  if (raw.includes("T")) return (raw.split("T")[1] ?? "").slice(0, 5);
  if (raw.length >= 5 && raw[2] === ":") return raw.slice(0, 5);
  return raw || "--:--";
}

function formatAuditCause(value: unknown): string {
  if (!isRecord(value)) return "canvas loop";
  const type = orStr(value.type, "canvas loop").replaceAll("_", " ");
  const chat = orStr(value.chat_id || value.run_chat_id).trim();
  const message = orStr(value.message_id).trim();
  if (chat && message) return `${type} from chat ${chat} message ${message}`;
  if (chat) return `${type} from chat ${chat}`;
  return type;
}

function formatAuditLinks(entry: Json): string {
  const cause = dict(entry.cause);
  const links: string[] = [];
  const chat = orStr(cause.chat_id).trim();
  const runChat = orStr(cause.run_chat_id).trim();
  if (chat) links.push(`<span class="tabbed-audit-link">chat ${escapeHtml(chat)}</span>`);
  if (runChat && runChat !== chat)
    links.push(`<span class="tabbed-audit-link">run chat ${escapeHtml(runChat)}</span>`);
  return links.join(" ");
}

function storySlide(slide: Json, quotes: Json[]): string {
  const eyebrow = orStr(slide.eyebrow).trim();
  const eyebrowHtml = eyebrow ? `<p class="tabbed-canvas-kicker">${escapeHtml(eyebrow)}</p>` : "";
  const ids = list(slide.quote_ids).map((q) => pyStr(q));
  const idSet = new Set(ids);
  const evidence = quotes.filter((q) => idSet.has(pyStr(q.id)));
  const trace = evidence.slice(0, 3).map(quoteBlock).join("\n");
  const lede = escapeHtml(orStr(slide.lede));
  let ledeHtml: string;
  if (lede && evidence.length) {
    const href = `#${traceId(orStr(slide.lede || slide.heading), ids)}`;
    ledeHtml = `<details class="tabbed-slide-trace"><summary><a class="tabbed-traceable" href="${href}">${lede}</a></summary><div class="tabbed-trace">${trace}</div></details>`;
  } else if (lede) ledeHtml = `<p class="tabbed-canvas-lede">${lede}</p>`;
  else ledeHtml = trace;
  return `
<article class="tabbed-story-slide">
  ${eyebrowHtml}
  <h3>${escapeHtml(orStr(slide.heading))}</h3>
  ${ledeHtml}
</article>
`.trim();
}

function conceptTile(concept: Json, quotes: Json[], index: number): string {
  const phrase = escapeHtml(orStr(concept.phrase));
  const tier = escapeHtml(orStr(concept.size_tier, "s"));
  const ids = list(concept.quote_ids).map((q) => pyStr(q));
  const evidence = quotes.filter((q) => ids.includes(pyStr(q.id)));
  const trace = evidence.slice(0, 4).map(quoteBlock).join("\n");
  const style = escapeHtml(conceptTileStyle(concept, index));
  if (trace) {
    const href = `#${traceId(orStr(concept.phrase), ids)}`;
    return `
<details class="tabbed-concept tabbed-concept-${tier}" style="${style}">
  <summary><a class="tabbed-traceable" href="${href}">${phrase}</a></summary>
  <div class="tabbed-trace">${trace}</div>
</details>
`.trim();
  }
  return `<div class="tabbed-concept tabbed-concept-${tier}" style="${style}"><span>${phrase}</span></div>`;
}

function stableHash(seed: string): number {
  return Number.parseInt(sha1(seed).slice(0, 12), 16);
}

function hashUnit(seed: string, salt: string): number {
  return stableHash(`${seed}:${salt}`) / 0xffffffffffff;
}

function scale(v: number, lo: number, hi: number): number {
  return lo + (hi - lo) * v;
}

function conceptTileStyle(concept: Json, index: number): string {
  const seed = orStr(concept.id) || orStr(concept.phrase) || String(index);
  const r = scale(hashUnit(seed, "rotation"), -1.2, 1.2);
  const delay = scale(hashUnit(seed, "delay"), 0, 6.95);
  const dur = scale(hashUnit(seed, "duration"), 6, 9);
  const ox = scale(hashUnit(seed, "offset-x"), -5, 5);
  const oy = scale(hashUnit(seed, "offset-y"), -4, 4);
  const mt = scale(hashUnit(seed, "margin-top"), -3, 5);
  const ms = scale(hashUnit(seed, "margin-side"), -4, 4);
  return (
    `transform:translate(${ox.toFixed(1)}px,${oy.toFixed(1)}px) rotate(${r.toFixed(2)}deg);` +
    `animation-delay:${delay.toFixed(2)}s;` +
    `animation-duration:${dur.toFixed(2)}s;` +
    `margin:${mt.toFixed(1)}px ${ms.toFixed(1)}px 0;`
  );
}

function boardCard(card: Json, quotes: Json[]): string {
  const group = escapeHtml(orStr(card.group, "the room"));
  const synthesis = escapeHtml(orStr(card.synthesis));
  const ids = list(card.quote_ids).map((q) => pyStr(q));
  const idSet = new Set(ids);
  const evidence = quotes.filter((q) => idSet.has(pyStr(q.id)));
  const trace = evidence.slice(0, 2).map(quoteBlock).join("\n");
  let receipt = "";
  if (trace) {
    const href = `#${traceId(orStr(card.synthesis || card.group), ids)}`;
    receipt =
      '<details class="tabbed-board-trace">' +
      `<summary><a class="tabbed-traceable" href="${href}">Receipts</a></summary>` +
      `<div class="tabbed-trace">${trace}</div></details>`;
  }
  return `
<article class="tabbed-board-card">
  <h3>${group}</h3>
  <p>${synthesis}</p>
  ${receipt}
</article>
`.trim();
}

function quoteBlock(quote: Json): string {
  const text = escapeHtml(orStr(quote.quote));
  const who = escapeHtml(orStr(quote.who, "participant"));
  const when = escapeHtml(orStr(quote.when));
  return `<blockquote class="tabbed-quote"><p>“${text}”</p><footer>${who} · ${when}</footer></blockquote>`;
}

function renderHostItems(state: CanvasState, tab: string): string {
  const items = state.host_items.filter((i) => !truthy(i.removed_at) && i.target_tab === tab);
  if (!items.length) return "";
  const rows = items
    .map(
      (i) =>
        `<div class="tabbed-host-item"><p>${escapeHtml(orStr(i.text))}</p><footer>${escapeHtml(orStr(i.person, "host"))}</footer></div>`,
    )
    .join("\n");
  return `<div class="tabbed-host-items">${rows}</div>`;
}

function tabDomId(tab: Tab): string {
  if (tab.kind === "board") return `board_${tab.grouping || "person"}`;
  return tab.kind;
}

const LANGUAGE_SEGMENTS: Record<string, string> = {
  cs: "cs-CZ",
  "cs-CZ": "cs-CZ",
  de: "de-DE",
  "de-DE": "de-DE",
  en: "en-US",
  "en-US": "en-US",
  es: "es-ES",
  "es-ES": "es-ES",
  fr: "fr-FR",
  "fr-FR": "fr-FR",
  it: "it-IT",
  "it-IT": "it-IT",
  nl: "nl-NL",
  "nl-NL": "nl-NL",
  uk: "uk-UA",
  "uk-UA": "uk-UA",
};

/** urllib.parse.quote(s, safe=""). */
function urlQuote(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function newTabChatHref(project: Json, reportName: string | null): string {
  const ws = orStr(project.workspace_id).trim();
  const pid = orStr(project.id).trim();
  if (!ws || !pid) return "#";
  const name = (reportName || orStr(project.report_name) || orStr(project.name) || "this").trim();
  const prefill = urlQuote(`I need a new tab in the ${name} canvas: `);
  const lang = urlQuote(LANGUAGE_SEGMENTS[orStr(project.language).trim()] ?? "en-US");
  return `/${lang}/w/${urlQuote(ws)}/projects/${urlQuote(pid)}/chats/new?prefill=${prefill}`;
}

function existingQuoteId(
  state: CanvasState,
  convId: string,
  chunkId: string,
  text: string,
): string | null {
  const n = normalizeWs(text);
  for (const q of state.quotes_ledger) {
    const src = quoteSource(q);
    if (orStr(src.conversation_id) !== convId) continue;
    if (orStr(src.chunk_id) !== chunkId) continue;
    if (normalizeWs(orStr(q.quote)) === n) return orStr(q.id);
  }
  return null;
}

function supportedQuoteIds(raw: unknown, idx: Map<number, string>): string[] {
  const out: string[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const n =
      typeof r === "number"
        ? Math.trunc(r)
        : typeof r === "string" && /^\s*[+-]?\d+\s*$/.test(r)
          ? Number.parseInt(r, 10)
          : typeof r === "boolean"
            ? Number(r)
            : Number.NaN;
    if (Number.isNaN(n)) continue;
    const id = idx.get(n);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function conceptScore(concept: Json, quotes: Json[]): number {
  const ids = new Set(list(concept.quote_ids).map((q) => pyStr(q)));
  const spread = new Set(
    quotes.filter((q) => ids.has(pyStr(q.id))).map((q) => orStr(quoteSource(q).conversation_id)),
  );
  return ids.size + spread.size * 2;
}

/** sorted(..., key=k, reverse=True) with Python tuple ordering; stable for ties. */
function sortDesc<T>(items: T[], key: (x: T) => (string | number)[]): T[] {
  return [...items].sort((a, b) => -compareTuples(key(a), key(b)));
}

function compareTuples(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string | number;
    const y = b[i] as string | number;
    const c =
      typeof x === "number" && typeof y === "number" ? x - y : pyCompare(String(x), String(y));
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Python string ordering: by code point. */
export function pyCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

/** s[:n] in code points. */
export function pySlice(s: string, n: number): string {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n).join("");
}
