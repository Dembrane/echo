import { newId } from "@echo/core";
import { pythonIso } from "@echo/legacy-shape";

/**
 * The additive canvas state kept on agent_loop (tabs, ledgers, host items), in the shape
 * the tick pipeline and the canvas renderer read. Only the parts the assistant's routes
 * touch live here: tab normalisation, the state read and patch, and host items.
 */

export type Obj = Record<string, unknown>;

const TAB_SET_V1 = ["crux", "concept_cloud", "story", "host_guide", "trace", "audit"] as const;
const SUPPORTED_TAB_KINDS = new Set([
  "crux",
  "concept_cloud",
  "story",
  "host_guide",
  "board",
  "trace",
  "audit",
]);
const HOST_TARGET_TABS = new Set(["crux", "concept_cloud", "story"]);

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

/** The value error the Python ledgers raised; routes answer it as 400 with its text. */
export class CanvasValueError extends Error {}

const asList = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const asDict = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
/** Python truthiness for the `a or b` fallbacks: empty lists and dicts count as absent. */
const truthy = (v: unknown): boolean => {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as Obj).length > 0;
  return true;
};
const either = (a: unknown, b: unknown) => (truthy(a) ? a : b);

function tabKind(value: unknown): string | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
  const kind = TAB_ALIASES[raw] ?? raw;
  return SUPPORTED_TAB_KINDS.has(kind) ? kind : null;
}

function tabConfig(raw: unknown): Obj | null {
  if (typeof raw === "string") {
    const kind = tabKind(raw);
    return kind ? { kind } : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Obj;
  const kind = tabKind(either(either(r.kind, r.tab), r.type));
  if (!kind) return null;
  const tab: Obj = { kind };
  if (kind === "board") {
    const grouping = String(truthy(r.grouping) ? r.grouping : "person")
      .trim()
      .toLowerCase();
    tab.grouping = ["", "voice", "speaker"].includes(grouping) ? "person" : grouping;
  }
  return tab;
}

const tabKey = (tab: Obj) =>
  tab.kind === "board" ? `board:${tab.grouping || "person"}` : String(tab.kind ?? "");

export function normalizeCanvasTabs(tabs: unknown): Obj[] {
  const source: unknown[] = Array.isArray(tabs) && tabs.length ? tabs : [...TAB_SET_V1];
  const out: Obj[] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const tab = tabConfig(raw);
    if (!tab) continue;
    const key = tabKey(tab);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tab);
  }
  return out.length ? out : TAB_SET_V1.map((kind) => ({ kind }));
}

/** The state from a loop row (canvas_* columns) or from a state object (bare keys). */
export function freshCanvasState(loop: Obj | null = null): Obj {
  const l = loop ?? {};
  const crux = asDict(either(l.crux, l.canvas_crux));
  return {
    schema_version: 1,
    tabs: normalizeCanvasTabs(either(l.tabs, l.canvas_tabs)),
    quotes_ledger: asList(either(l.quotes_ledger, l.canvas_quotes_ledger)),
    concepts_ledger: asList(either(l.concepts_ledger, l.canvas_concepts_ledger)),
    crux: truthy(crux) ? crux : { question: "", history: [] },
    host_items: asList(either(l.host_items, l.canvas_host_items)),
    story_slides: asList(either(l.story_slides, l.canvas_story_slides)),
    host_guide: asDict(either(l.host_guide, l.canvas_host_guide)),
    board_cards: asList(either(l.board_cards, l.canvas_board_cards)),
    audit_entries: asList(either(l.audit_entries, l.canvas_audit_entries)),
  };
}

/** The agent_loop columns a state is written back to. */
export function statePatch(state: Obj): Obj {
  return {
    canvas_tabs: normalizeCanvasTabs(state.tabs),
    canvas_quotes_ledger: either(state.quotes_ledger, []),
    canvas_concepts_ledger: either(state.concepts_ledger, []),
    canvas_crux: either(state.crux, { question: "", history: [] }),
    canvas_host_items: either(state.host_items, []),
    canvas_story_slides: either(state.story_slides, []),
    canvas_host_guide: either(state.host_guide, {}),
    canvas_board_cards: either(state.board_cards, []),
  };
}

export function normalizeTargetTab(target: string | null): string {
  const raw = (target || "story").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  const kind = { cloud: "concept_cloud", concept: "concept_cloud", concepts: "concept_cloud" }[raw];
  const normalized = kind ?? raw;
  if (!HOST_TARGET_TABS.has(normalized))
    throw new CanvasValueError("target_tab must be one of crux, concept_cloud, or story");
  return normalized;
}

export function hostItem(
  o: {
    text: string;
    targetTab: string;
    person: string | null;
    chatId: string | null;
    messageId: string | null;
  },
  now: Date,
): Obj {
  const target = normalizeTargetTab(o.targetTab);
  return {
    id: newId(),
    text: o.text.trim(),
    person: o.person ? o.person.trim() : null,
    target_tab: target,
    source: { chat_id: o.chatId, message_id: o.messageId },
    added_at: pythonIso(now),
    removed_at: null,
  };
}

export function appendHostItem(state: Obj, item: Obj): Obj {
  const s = freshCanvasState(state);
  return { ...s, host_items: [...(s.host_items as Obj[]), item] };
}

/** Marks every live host item matching the id or containing the text as removed. */
export function removeHostItem(state: Obj, idOrText: string, now: Date): [Obj, boolean] {
  const s = freshCanvasState(state);
  const needle = idOrText.trim().toLowerCase();
  let removed = false;
  const items = (s.host_items as Obj[]).map((item) => {
    if (truthy(item.removed_at)) return item;
    const byId = String(item.id ?? "").toLowerCase() === needle;
    const byText =
      needle !== "" &&
      String(item.text ?? "")
        .toLowerCase()
        .includes(needle);
    if (!byId && !byText) return item;
    removed = true;
    return { ...item, removed_at: pythonIso(now) };
  });
  return [{ ...s, host_items: items }, removed];
}
