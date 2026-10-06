import type { Json } from "../contracts";
import { casefold, normalizeText } from "../text";
import { AnswerDidNotParse, jsonFromText } from "./model";
import type { ProducerServices } from "./services";

/**
 * The popcorn pieces the stakeholders and popcorn recipes read, ported from
 * dembrane/popcorn (analysis, gates, grounding, model) so the recipes shape, gate and
 * ground output exactly as the live session does. Quote ids, gate flag texts and the
 * corpus layout feed step cache keys and what a retry sends back to the model.
 */

export const STAKEHOLDERS_PROMPT = "stakeholders-v0.9";
export const POPCORN_PROMPT = "popcorn-v1.8";
export const VALIDATE_PROMPT = "popcorn-validate";
export const ANALYSIS_MAX_TOKENS = 65536;
export const ANALYSIS_TIMEOUT_MS = 300_000;
export const TOKEN_KEYS = ["prompt_tokens", "completion_tokens", "total_tokens"];

/** re.sub(r"\s+", " ", text).strip().casefold() */
export const norm = (text: string) => casefold(normalizeText(text));

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

// Vertex rejects this schema with maxItems at these depths; the caps live in shapeStakeholders.
export const MAX_STAKEHOLDERS = 9;
export const MAX_RELATIONS = 12;
export const MAX_ASPECTS = 3;
export const MAX_QUOTES = 3;

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

/** Above this the cross-conversation corpus shares one character budget. */
export const MAX_ANALYSIS_CHARS = 600_000;

export const cpLength = (s: string) => [...s].length;
export const cpSlice = (s: string, end: number) => [...s].slice(0, end).join("");

/** One prompt-sized document, each transcript announced by its id. */
export function buildCorpus(transcripts: readonly (readonly [string, string])[]): string {
  return transcripts
    .map(([tid, text]) => `TRANSCRIPT id: ${tid}\n${text}\nEND TRANSCRIPT ${tid}`)
    .join("\n\n");
}

/**
 * Shares a character budget: a transcript short enough for its equal share keeps every
 * character, and what it leaves goes to the longer ones in equal measure.
 */
export function allocateChars(
  lengths: Readonly<Record<string, number>>,
  budget: number,
): Record<string, number> {
  const total = Object.values(lengths).reduce((a, b) => a + b, 0);
  if (total <= budget) return { ...lengths };
  const quota: Record<string, number> = {};
  let remaining = budget;
  // Python's sorted() is stable: equal lengths keep their insertion order.
  let pending = Object.entries(lengths).sort((a, b) => a[1] - b[1]);
  while (pending.length) {
    const share = Math.floor(remaining / pending.length);
    const [tid, n] = pending[0] as [string, number];
    if (n <= share) {
      quota[tid] = n;
      remaining -= n;
      pending = pending.slice(1);
    } else {
      for (const [t] of pending) quota[t] = share;
      pending = [];
    }
  }
  return quota;
}

/** The user message every popcorn analysis call sends. */
export function transcriptMessage(transcriptId: string, transcript: string, hostNote = ""): string {
  const note = hostNote
    ? `HOST NOTE ON VOICE (from the facilitator; every rule above still holds):\n${hostNote}\n\n`
    : "";
  return `${note}Transcript id: ${transcriptId}\n\nTRANSCRIPT START\n${transcript}\nTRANSCRIPT END`;
}

const ATTRIBUTES = /\b(he|she|him|her|his|hers|himself|herself|introducing (him|her)self)\b/i;
// A proper noun after the first word is a person or an organisation; "AI" is neither.
const PROPER = /(?<!^)(?<![.!?]\s)\b(?!AI\b)[A-Z][a-z]+/;

/** True when a context line assigns a speaker: a pronoun, a name, an organisation. */
export const attributes = (context: string) =>
  ATTRIBUTES.test(context) || PROPER.test(context.trim());

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface BookQuote {
  id: string;
  transcript: string;
  text: string;
  context?: string;
}

/** Assigns quote ids, and refuses any quote that is not verbatim in some transcript. */
export class QuoteBook {
  readonly quotes: BookQuote[] = [];
  rejected = 0;
  /** Quotes the model credited to one table that only another said. */
  reattributed = 0;
  private readonly normSources: Map<string, string>;
  private readonly seen = new Map<string, string>();
  private next = 1;

  constructor(
    sources: Readonly<Record<string, string>>,
    private readonly names: ReadonlySet<string> = new Set(),
  ) {
    this.normSources = new Map(Object.entries(sources).map(([tid, t]) => [tid, norm(t)]));
  }

  private safeContext(raw: unknown): string {
    const ctx = String(raw ?? "").trim();
    if (!ctx || attributes(ctx)) return "";
    for (const n of this.names) if (new RegExp(`\\b${escapeRegExp(n)}\\b`).test(ctx)) return "";
    return ctx;
  }

  add(q: Json): string | null {
    const text = String(q.text || "").trim();
    if (!text) return null;
    const key = norm(text);
    const tid = String(q.transcript || "");
    let foundIn: string | null = (this.normSources.get(tid) ?? "").includes(key) ? tid : null;
    if (foundIn === null) {
      // The words are the evidence; the table that said them is their provenance.
      for (const [cand, body] of this.normSources)
        if (body.includes(key)) {
          foundIn = cand;
          this.reattributed++;
          break;
        }
    }
    if (foundIn === null) {
      this.rejected++;
      return null;
    }
    const seenKey = `${foundIn}\x00${key}`;
    const known = this.seen.get(seenKey);
    if (known) return known;
    const qid = `q${this.next++}`;
    const entry: BookQuote = { id: qid, transcript: foundIn, text };
    const ctx = this.safeContext(q.context);
    if (ctx) entry.context = ctx;
    this.quotes.push(entry);
    this.seen.set(seenKey, qid);
    return qid;
  }

  addAll(qs: unknown): string[] {
    return (Array.isArray(qs) ? qs : [])
      .filter((q): q is Json => !!q && typeof q === "object" && !Array.isArray(q))
      .map((q) => this.add(q))
      .filter((x): x is string => x !== null);
  }
}

/** Python's round(x, ndigits=2): exact binary ties go to the even neighbour. */
export function pyRound2(x: number): number {
  const y = x * 100;
  if (Number.isInteger(x * 8) && Math.abs(y - Math.trunc(y)) === 0.5) {
    const lo = Math.floor(y);
    return (lo % 2 === 0 ? lo : lo + 1) / 100;
  }
  return Number(x.toFixed(2));
}

export function shapeStakeholders(
  raw: Json,
  book: QuoteBook,
): { stakeholders: Json[]; relations: Json[] } {
  const people: Json[] = [];
  const byName = new Map<string, string>();
  ((raw.stakeholders as Json[] | undefined) ?? []).slice(0, MAX_STAKEHOLDERS).forEach((s, i) => {
    const sid = `s${i + 1}`;
    byName.set(norm(String(s.name)), sid);
    const ev: Json = { rung: s.rung };
    if (s.invokedBy) ev.invokedBy = s.invokedBy;
    people.push({
      id: sid,
      name: s.name,
      role: s.role,
      stake: s.stake,
      quoteIds: book.addAll(((s.quotes as unknown[] | undefined) ?? []).slice(0, MAX_QUOTES)),
      evidence: ev,
      weight: {
        stake: pyRound2(Number(s.stakeWeight)),
        mentions: pyRound2(Number(s.mentionsWeight)),
      },
    });
  });
  const relations: Json[] = [];
  const seenPairs = new Set<string>();
  for (const r of (raw.relations as Json[] | undefined) ?? []) {
    const between = (r.between as unknown[] | undefined) ?? [];
    if (between.length !== 2 || relations.length >= MAX_RELATIONS) continue;
    const ids = between.map((nm) => byName.get(norm(String(nm))));
    // A relation to nobody is not a relation.
    if (ids.some((x) => x === undefined) || ids[0] === ids[1]) continue;
    const pair = [...(ids as string[])].sort().join("|");
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const aspects: Json[] = [];
    for (const a of ((r.aspects as Json[] | undefined) ?? []).slice(0, MAX_ASPECTS)) {
      const qids = book.addAll(((a.quotes as unknown[] | undefined) ?? []).slice(0, MAX_QUOTES));
      if (!qids.length) continue; // no quote, no aspect
      aspects.push({ kind: a.kind, note: a.note, quoteIds: qids });
    }
    relations.push({
      id: `r${relations.length + 1}`,
      between: [...(ids as string[])],
      label: r.label,
      intensity: pyRound2(Number(r.intensity)),
      sentiment: pyRound2(Number(r.sentiment)),
      unowned: Boolean(r.unowned),
      detail: r.detail,
      aspects,
    });
  }
  return { stakeholders: people, relations };
}

// ── gates ───────────────────────────────────────────────────────────────

const JOINED_WORDS = /(\band\b|&|\/)/i;
// A comma joins two groups when a second name follows it; a qualifier after it is one group.
const JOINED_COMMA = /,\s*[A-ZÀ-Þ]/;
const PEOPLE =
  /\b(people|persons?|staff|workers?|users?|members?|residents?|volunteers?|developers?|hosts?|facilitators?|leaders?|managers?|teams?|citizens?|participants?|women|men|youth|parents?|students?|employees?|customers?|clients?|partners?|funders?|commissioners?|officials?|experts?|practitioners?|newcomers?|colleagues?|organisations?|organizations?|charities|charity|groups?|communit(y|ies)|neighbou?rs?|families|family|founders?|owners?|directors?|board|councils?|makers?)\b/i;
const THING =
  /\b(tool|tools|system|systems|technology|software|platform|app|recording|recordings|algorithm|ai|bot|machine|summary|dashboard|black box|pressure|pressures|demand|demands|force|forces|factor|factors|trend|trends|process|processes|structure|structures|culture|cultures|market|markets|environment|environments)$/i;

/** Python's repr of a str, for the gate texts the model reads back. */
export function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = s
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  if (q === "'") body = body.replaceAll("'", "\\'");
  return `${q}${body}${q}`;
}

/** One group, one name, and the group is people. */
export function nameFlags(stake: Json): string[] {
  const flags: string[] = [];
  for (const g of (stake.stakeholders as Json[] | undefined) ?? []) {
    const name = String(g.name ?? "");
    const gid = g.id ?? "?";
    if (JOINED_WORDS.test(name) || JOINED_COMMA.test(name))
      flags.push(`${gid}: ${pyStrRepr(name)} joins two groups on one card; one group, one name`);
    else if (THING.test(name.trim()) && !PEOPLE.test(name))
      flags.push(
        `${gid}: ${pyStrRepr(name)} names a thing, not people; name the people who make or run it`,
      );
  }
  return flags;
}

export function components(stake: Json): string[][] {
  const groups = ((stake.stakeholders as Json[] | undefined) ?? []).map((g) => String(g.id));
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    adj.set(a, list);
  };
  for (const r of (stake.relations as Json[] | undefined) ?? []) {
    const between = (r.between as unknown[] | undefined) ?? [null, null];
    const [a, b] = [between[0], between[1]].map((x) =>
      x === undefined || x === null ? null : String(x),
    );
    if (a && b && groups.includes(a) && groups.includes(b) && a !== b) {
      link(a, b);
      link(b, a);
    }
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const g of groups) {
    if (seen.has(g)) continue;
    const comp: string[] = [];
    const queue = [g];
    seen.add(g);
    while (queue.length) {
      const x = queue.shift() as string;
      comp.push(x);
      for (const y of adj.get(x) ?? [])
        if (!seen.has(y)) {
          seen.add(y);
          queue.push(y);
        }
    }
    out.push(comp);
  }
  return out;
}

/** One connected map, no group without a relation. */
export function islandFlags(stake: Json): string[] {
  const names = new Map(
    ((stake.stakeholders as Json[] | undefined) ?? []).map((g) => [
      String(g.id),
      String(g.name ?? g.id),
    ]),
  );
  const comps = components(stake);
  if (comps.length <= 1) return [];
  // sorted(key=len, reverse=True) is stable: equal sizes keep their order.
  comps.sort((a, b) => b.length - a.length);
  return comps.slice(1).map((comp) => {
    if (comp.length === 1) {
      const g = comp[0] as string;
      return `${g}: ${pyStrRepr(names.get(g) as string)} has no relation to any other group; add the relation the transcripts support, or drop the group`;
    }
    return `island: ${comp.map((g) => `${g} ${pyStrRepr(names.get(g) as string)}`).join(", ")} connect only to each other; add the relation that joins them to the rest, or drop them`;
  });
}

/** Whether a phrase appears word for word (whitespace and case aside) in its transcript. */
export function isVerbatim(phrase: string, transcript: string): boolean {
  const key = norm(phrase);
  return Boolean(key) && norm(transcript).includes(key);
}

/** Popcorn's analysis judgement: the fast group, one JSON answer, its token usage alongside. */
export async function generateWithUsage(
  services: ProducerServices,
  o: { systemPrompt: string; userText: string; schema: Json; thinking?: boolean },
): Promise<[Json, Record<string, number>]> {
  const response = await services.complete({
    system: o.systemPrompt,
    user: o.userText,
    temperature: 0,
    maxTokens: ANALYSIS_MAX_TOKENS,
    jsonSchema: o.schema,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    ...(o.thinking === false && { thinkingBudget: 0 }),
  });
  try {
    return [jsonFromText(response.text), { ...response.usage }];
  } catch (err) {
    if (err instanceof AnswerDidNotParse) throw new Error("model answer did not parse");
    throw err;
  }
}
