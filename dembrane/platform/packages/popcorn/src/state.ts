import { dict, isRecord, type Json, list, pyStr, truthy } from "./py";
import { isLanguage } from "./settings";

/**
 * The extraction state a session's loop row carries (agent_loop.popcorn_state): the
 * conversations read so far, their phrases, the one quote registry and the analysis. The
 * tick is its only writer; everything the deck shows is assembled from it.
 */

/** 2: one quote registry at the top of the state, validation per transcript. */
export const STATE_VERSION = 2;

export function freshState(): Json {
  return {
    version: STATE_VERSION,
    run: 0,
    order: [],
    conversations: {},
    quotes: [],
    analysis: null,
  };
}

/** `int(x or 0)` for the run counter. */
function pyInt(v: unknown): number {
  if (!truthy(v)) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function normalizeState(raw: unknown): Json {
  const state = freshState();
  if (!isRecord(raw)) return state;
  state.run = pyInt(raw.run);
  // Provenance belongs to the data, never to a hideable screen setting.
  if (isRecord(raw.demo) && raw.demo.synthetic === true) {
    const demo: Json = { ...raw.demo };
    for (const key of ["disclosure", "notice", "portal_urls"])
      if (!isRecord(demo[key])) delete demo[key];
    state.demo = demo;
  }
  const conversations: Json = {};
  for (const [k, v] of Object.entries(dict(raw.conversations)))
    if (isRecord(v)) conversations[k] = v;
  state.conversations = conversations;
  const order = list(raw.order)
    .map((cid) => pyStr(cid))
    .filter((cid) => cid in conversations);
  for (const cid of Object.keys(conversations)) if (!order.includes(cid)) order.push(cid);
  state.order = order;
  const analysis: Json | null = isRecord(raw.analysis) ? { ...raw.analysis } : null;
  let quotesRaw: unknown = raw.quotes;
  if (!Array.isArray(quotesRaw) && analysis !== null) {
    // Version 1 kept the registry inside the analysis block; it is the session's now.
    quotesRaw = analysis.quotes;
    delete analysis.quotes;
  } else if (analysis !== null) delete analysis.quotes;
  state.quotes = list(quotesRaw).filter((q) => isRecord(q) && truthy(q.id));
  state.analysis = analysis;
  // Translations the host asked for, per language, keyed by source text.
  if (isRecord(raw.translations)) {
    const tables: Json = {};
    for (const [lang, table] of Object.entries(raw.translations)) {
      if (!isLanguage(lang) || !isRecord(table)) continue;
      tables[lang] = Object.fromEntries(
        Object.entries(table).filter(([, v]) => typeof v === "string"),
      );
    }
    state.translations = tables;
  }
  return state;
}

export function isSyntheticSession(state: Json): boolean {
  return dict(state.demo).synthetic === true;
}

/**
 * Every quote id anything in this structure still cites, under either name the deck reads:
 * `quoteId` on a phrase, `quoteIds` on a tension, a stakeholder or an aspect.
 */
export function referencedQuoteIds(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (isRecord(value)) {
    if (typeof value.quoteId === "string") into.add(value.quoteId);
    if (Array.isArray(value.quoteIds)) for (const q of value.quoteIds) into.add(pyStr(q));
    for (const nested of Object.values(value))
      if (isRecord(nested) || Array.isArray(nested)) referencedQuoteIds(nested, into);
  } else if (Array.isArray(value)) for (const nested of value) referencedQuoteIds(nested, into);
  return into;
}

export function stateCounts(state: Json): Json {
  const conversations = Object.values(dict(state.conversations)).map(dict);
  const phrases = conversations.reduce((n, c) => n + list(c.items).length, 0);
  const done = conversations.filter((c) => truthy(c.done)).length;
  const analysis = dict(state.analysis);
  return {
    conversations: conversations.length,
    conversations_read: done,
    reading: conversations.length - done,
    phrases,
    validated: conversations.reduce(
      (n, c) => n + list(c.items).filter((i) => truthy(dict(i).quoteId)).length,
      0,
    ),
    held_back: conversations.reduce((n, c) => n + list(dict(c.review).dropped).length, 0),
    quotes: list(state.quotes).length,
    tensions: list(dict(analysis.tensions).tensions).length,
    stakeholders: list(dict(analysis.stakeholders).stakeholders).length,
    analysis_updated_at: analysis.updated_at ?? null,
    run: state.run ?? null,
  };
}
