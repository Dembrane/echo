import { dict, isRecord, type Json, list, orStr, pyRound, pyStr } from "../py";
import { attributes, norm, pySplit, pyStrip } from "../text";
import { escapeRegExp, f, sha1Hex, WB_END, WB_START } from "./util";

/**
 * Popcorn contracts and the shaping of model answers (popcorn analysis.py): the phrase
 * gates, the quote registry that refuses anything not verbatim, and the stakeholders
 * slide. Parts of this duplicate packages/analysis/src/recipes/popcorn-shared.ts on
 * port/analysis until the two packages merge; this copy adds the registry seeding the
 * live session needs.
 */

export const POPCORN_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase"],
        properties: { phrase: { type: "string", minLength: 1, maxLength: 90 } },
      },
    },
  },
};

const QUOTE: Json = {
  type: "object",
  additionalProperties: false,
  required: ["transcript", "text"],
  properties: {
    transcript: { type: "string" },
    text: { type: "string", minLength: 12, maxLength: 400 },
    context: { type: "string", maxLength: 200 },
  },
};

// Vertex rejects maxItems at these depths; the caps are enforced in shapeStakeholders.
const MAX_STAKEHOLDERS = 9;
const MAX_RELATIONS = 12;
const MAX_ASPECTS = 3;
const MAX_QUOTES = 3;

export const STAKEHOLDERS_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["stakeholders", "relations"],
  properties: {
    stakeholders: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role", "stake", "rung", "stakeWeight", "mentionsWeight", "quotes"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 48 },
          role: { type: "string", minLength: 5, maxLength: 160 },
          stake: { type: "string", minLength: 5, maxLength: 200 },
          rung: { type: "string", enum: ["voiced", "named", "inferred"] },
          invokedBy: { type: "string", maxLength: 48 },
          stakeWeight: { type: "number", minimum: 0, maximum: 1 },
          mentionsWeight: { type: "number", minimum: 0, maximum: 1 },
          quotes: { type: "array", items: QUOTE },
        },
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["between", "label", "intensity", "sentiment", "unowned", "detail", "aspects"],
        properties: {
          between: { type: "array", minItems: 2, items: { type: "string", maxLength: 48 } },
          label: { type: "string", minLength: 3, maxLength: 70 },
          intensity: { type: "number", minimum: 0, maximum: 1 },
          sentiment: { type: "number", minimum: -1, maximum: 1 },
          unowned: { type: "boolean" },
          detail: { type: "string", minLength: 20, maxLength: 500 },
          aspects: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "note", "quotes"],
              properties: {
                kind: { type: "string", enum: ["power", "risk", "opportunity"] },
                note: { type: "string", minLength: 10, maxLength: 300 },
                quotes: { type: "array", minItems: 1, items: QUOTE },
              },
            },
          },
        },
      },
    },
  },
};

// The prompt asks for twelve words; the gate tolerates thirteen (bloat begins at fourteen).
const MAX_PHRASE_WORDS = 13;
const MAX_PHRASE_CHARS = 90;

/** The characters Python's str whitespace covers, which JS's own class does not quite. */
const PY_WS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_RUN = new RegExp(`[${PY_WS}]+`, "gu");

/** str.strip(chars) */
export function stripChars(text: string, chars: string, left = true, right = true): string {
  const set = new Set([...chars]);
  const cs = [...text];
  let a = 0;
  let b = cs.length;
  while (left && a < b && set.has(cs[a] as string)) a++;
  while (right && b > a && set.has(cs[b - 1] as string)) b--;
  return cs.slice(a, b).join("");
}

/** One prompt-sized document, each transcript announced by its id. */
export function buildCorpus(transcripts: readonly (readonly [string, string])[]): string {
  return transcripts
    .map(([tid, text]) => `TRANSCRIPT id: ${tid}\n${text}\nEND TRANSCRIPT ${tid}`)
    .join("\n\n");
}

/** Above this the cross-conversation corpus shares one character budget. */
export const MAX_ANALYSIS_CHARS = 600_000;

/**
 * Shares a character budget: a transcript short enough for its equal share keeps every
 * character, and what it leaves goes to the longer ones in equal measure.
 */
export function allocateChars(
  lengths: ReadonlyMap<string, number>,
  budget: number,
): Map<string, number> {
  const total = [...lengths.values()].reduce((a, b) => a + b, 0);
  if (total <= budget) return new Map(lengths);
  const quota = new Map<string, number>();
  let remaining = budget;
  // sorted() is stable: equal lengths keep their order.
  let pending = [...lengths.entries()].sort((a, b) => a[1] - b[1]);
  while (pending.length) {
    const share = Math.floor(remaining / pending.length);
    const [tid, n] = pending[0] as [string, number];
    if (n <= share) {
      quota.set(tid, n);
      remaining -= n;
      pending = pending.slice(1);
    } else {
      for (const [t] of pending) quota.set(t, share);
      pending = [];
    }
  }
  return quota;
}

/**
 * The deterministic first-run gates on one extractor answer: unique phrases, at most
 * thirteen words, no quotation marks or terminal punctuation. A question mark survives
 * as `question`. The id follows the phrase text, so a later re-read keeps it.
 */
export function shapePopcornItems(raw: unknown, transcriptId: string): Json[] {
  const items = isRecord(raw) ? raw.items : null;
  const out: Json[] = [];
  const seen = new Set<string>();
  for (const item of list(items)) {
    if (!isRecord(item)) continue;
    let phrase = pyStrip(orStr(item.phrase).replace(PY_WS_RUN, " "));
    phrase = pyStrip(stripChars(phrase, "\"'“”‘’"));
    const question = phrase.endsWith("?");
    phrase = pyStrip(stripChars(phrase, ".!?;:", false, true));
    if (
      !phrase ||
      [...phrase].length > MAX_PHRASE_CHARS ||
      pySplit(phrase).length > MAX_PHRASE_WORDS
    )
      continue;
    if (phrase.includes('"') || phrase.includes("“") || phrase.includes("”")) continue;
    const key = norm(phrase);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: Json = { id: `p-${transcriptId}-${sha1Hex(key).slice(0, 8)}`, phrase };
    if (question) entry.question = true;
    out.push(entry);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Assigns quote ids and refuses any quote that is not verbatim. One book serves a whole
 * tick, seeded with the session's registry so ids the deck holds stay valid; a seeded
 * quote whose transcript is gone is dropped with it.
 */
export class QuoteBook {
  readonly quotes: Json[] = [];
  rejected = 0;
  /** Quotes the model credited to one table that only another said. */
  reattributed = 0;
  private readonly normSources: Map<string, string>;
  private readonly seen = new Map<string, string>();
  private next = 1;

  constructor(
    sources: ReadonlyMap<string, string>,
    private readonly names: ReadonlySet<string> = new Set(),
    existing: readonly unknown[] = [],
  ) {
    this.normSources = new Map([...sources].map(([tid, t]) => [tid, norm(t)]));
    for (const raw of existing) {
      if (!isRecord(raw)) continue;
      const m = /^q(\d+)$/.exec(orStr(raw.id));
      const text = pyStrip(orStr(raw.text));
      const key = norm(text);
      const tid = orStr(raw.transcript);
      if (
        !m ||
        !text ||
        this.seen.has(`${tid}\u0000${key}`) ||
        !(this.normSources.get(tid) ?? "").includes(key)
      )
        continue;
      const entry: Json = { id: raw.id, transcript: tid, text };
      const ctx = this.safeContext(raw.context);
      if (ctx) entry.context = ctx;
      this.quotes.push(entry);
      this.seen.set(`${tid}\u0000${key}`, String(raw.id));
      this.next = Math.max(this.next, Number(m[1]) + 1);
    }
  }

  /** A context line that says where the moment sits, never who spoke. */
  private safeContext(raw: unknown): string {
    const ctx = pyStrip(orStr(raw));
    if (!ctx || attributes(ctx)) return "";
    for (const n of this.names)
      if (new RegExp(`${WB_START}${escapeRegExp(n)}${WB_END}`, "u").test(ctx)) return "";
    return ctx;
  }

  add(q: Json): string | null {
    const text = pyStrip(orStr(q.text));
    if (!text) return null;
    const key = norm(text);
    const tid = orStr(q.transcript);
    let foundIn: string | null = (this.normSources.get(tid) ?? "").includes(key) ? tid : null;
    if (foundIn === null)
      for (const [cand, body] of this.normSources)
        if (body.includes(key)) {
          // The words are the evidence; the table that said them is their provenance.
          foundIn = cand;
          this.reattributed++;
          break;
        }
    if (foundIn === null) {
      this.rejected++;
      return null;
    }
    const seenKey = `${foundIn}\u0000${key}`;
    const known = this.seen.get(seenKey);
    if (known) return known;
    const qid = `q${this.next++}`;
    const entry: Json = { id: qid, transcript: foundIn, text };
    const ctx = this.safeContext(q.context);
    if (ctx) entry.context = ctx;
    this.quotes.push(entry);
    this.seen.set(seenKey, qid);
    return qid;
  }

  addAll(qs: unknown): string[] {
    return list(qs)
      .filter(isRecord)
      .map((q) => this.add(q))
      .filter((x): x is string => x !== null);
  }
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

/** The stakeholders slide from one answer; weights are floats Python keeps as floats. */
export function shapeStakeholders(raw: Json, book: QuoteBook): Json {
  const people: Json[] = [];
  const byName = new Map<string, string>();
  list(raw.stakeholders)
    .slice(0, MAX_STAKEHOLDERS)
    .forEach((rawS, i) => {
      const s = dict(rawS);
      const sid = `s${i + 1}`;
      byName.set(norm(pyStr(s.name)), sid);
      const ev: Json = { rung: s.rung };
      if (s.invokedBy) ev.invokedBy = s.invokedBy;
      people.push({
        id: sid,
        name: s.name,
        role: s.role,
        stake: s.stake,
        quoteIds: book.addAll(list(s.quotes).slice(0, MAX_QUOTES)),
        evidence: ev,
        weight: {
          stake: f(pyRound(num(s.stakeWeight), 2)),
          mentions: f(pyRound(num(s.mentionsWeight), 2)),
        },
      });
    });
  const relations: Json[] = [];
  const seenPairs = new Set<string>();
  for (const rawR of list(raw.relations)) {
    const r = dict(rawR);
    const between = list(r.between);
    if (between.length !== 2 || relations.length >= MAX_RELATIONS) continue;
    const ids = between.map((nm) => byName.get(norm(pyStr(nm))));
    // A relation to nobody is not a relation.
    if (ids.some((x) => x === undefined) || ids[0] === ids[1]) continue;
    const pair = [...(ids as string[])].sort().join("|");
    if (seenPairs.has(pair)) continue; // authored once, for both groups
    seenPairs.add(pair);
    const aspects: Json[] = [];
    for (const rawA of list(r.aspects).slice(0, MAX_ASPECTS)) {
      const a = dict(rawA);
      const qids = book.addAll(list(a.quotes).slice(0, MAX_QUOTES));
      if (!qids.length) continue; // no quote, no aspect
      aspects.push({ kind: a.kind, note: a.note, quoteIds: qids });
    }
    relations.push({
      id: `r${relations.length + 1}`,
      between: [...(ids as string[])],
      label: r.label,
      intensity: f(pyRound(num(r.intensity), 2)),
      sentiment: f(pyRound(num(r.sentiment), 2)),
      unowned: Boolean(r.unowned),
      detail: r.detail,
      aspects,
    });
  }
  return { stakeholders: people, relations };
}
