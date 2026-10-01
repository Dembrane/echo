import { AsyncLocalStorage } from "node:async_hooks";
import type { Json } from "../contracts";
import { sha256Hex } from "../hashing";
import { groundQuote } from "../maprecipe";
import collisionsPrompt from "../prompts/tensions-collisions-v1.md" with { type: "text" };
import handedPrompt from "../prompts/tensions-handed.md" with { type: "text" };
import supportPrompt from "../prompts/tensions-support-v1.md" with { type: "text" };
import verifyPrompt from "../prompts/tensions-verify-v1.md" with { type: "text" };
import writePrompt from "../prompts/tensions-write-v1.md" with { type: "text" };
import { pyRepr, sortedStrings } from "../registry";
import { casefold, normKey, pySplit } from "../text";
import { dataBlock } from "./model";
import {
  corpus,
  DEDUPE_SYSTEM,
  dedupeTensions,
  findHanded,
  type Generate,
  handedListing,
  Judge,
  MAX_POSITIONS_TOTAL,
  MAX_TENSIONS,
  MIN_ZERO_SUM,
  pyStr,
  WRITE_SCHEMA as STAGE_WRITE_SCHEMA,
  screenFlags,
  tablesOf,
  trimPositions,
  W,
  WB_END,
  WB_START,
} from "./tensions-stages";

/**
 * Tensions from saved arguments, the pipeline half (dembrane/analysis/recipes/tensions.py
 * run_tensions): positions from pinned arguments without a model call, then framing,
 * collisions, verification, dedupe, support and writing, every judgement one model call.
 * The prompts it builds are hashed into the recipe's step keys, so their text must stay
 * byte for byte what the Python built; test/tensions.test.ts replays recorded calls to
 * hold it to that.
 */

export const RECIPE_ID = "tensions";
export const RECIPE_VERSION = "tensions-from-arguments-v2";

export const PROMPTS: Readonly<Record<string, string>> = {
  handed: handedPrompt,
  collisions: collisionsPrompt,
  verify: verifyPrompt,
  support: supportPrompt,
  write: writePrompt,
};
export const PROMPT_NAMES = ["handed", "collisions", "verify", "support", "write"];
export const DEDUPE_PROMPT_NAME = "dedupe";

export const MIN_CONVERSATIONS = 2;
export const MAX_POSITIONS = MAX_POSITIONS_TOTAL;
export const FOCAL_BATCH = 10;
export const MAX_CANDIDATES = 24;
export const MAX_PAIRS_PER_POSITION = 4;
export const MAX_SUPPORTERS_PER_POLE = 3;
export const MIN_SUPPORT_STRENGTH = 0.5;
export const QUOTES_PER_POLE = 2;

export const NOT_ASSESSED =
  "- not assessed for this run: only passages around the evidence were available, so what the rooms were handed is unknown";
export const SUGGEST_REFRESH = "refresh_arguments";

const HEDGED = new RegExp(
  `${WB_START}(maybe|perhaps|possibly|i wonder|wondering|not sure|just an idea|i guess|might be)${WB_END}`,
  "iu",
);

export type InputSet = "raw" | "deduplicated";
export const RELATION_BY_POLE: Readonly<Record<string, string>> = {
  A: "supports_pole_a",
  B: "supports_pole_b",
};

// Nested maxItems makes Vertex reject a whole schema, so sizes are checked in code.
export const COLLISIONS_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["collisions"],
  properties: {
    collisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["focal", "other", "question", "why", "zero_sum"],
        properties: {
          focal: { type: "string", maxLength: 12 },
          other: { type: "string", maxLength: 12 },
          question: { type: "string", maxLength: 160 },
          why: { type: "string", maxLength: 240 },
          zero_sum: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};
export const VERIFY_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["valid", "opposed", "question", "reason", "poleA", "poleB"],
  properties: {
    valid: { type: "boolean" },
    opposed: { type: "boolean" },
    question: { type: "string", maxLength: 160 },
    reason: { type: "string", maxLength: 300 },
    poleA: { type: "string", maxLength: 60 },
    poleB: { type: "string", maxLength: 60 },
  },
};
export const SUPPORT_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["supporters"],
  properties: {
    supporters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "pole", "strength", "why"],
        properties: {
          id: { type: "string", maxLength: 12 },
          pole: { type: "string", enum: ["A", "B", "neither"] },
          strength: { type: "number", minimum: 0, maximum: 1 },
          why: { type: "string", maxLength: 200 },
        },
      },
    },
  },
};
/** Its own object, so the recipe can tell its write calls from popcorn's. */
export const WRITE_SCHEMA: Json = { ...STAGE_WRITE_SCHEMA };

export interface Evidence {
  readonly conversationId: string;
  readonly quote: string;
  readonly location?: unknown;
}

export interface ArgumentRevision {
  readonly revisionId: string;
  readonly objectId: string;
  readonly type: "argument" | "deduplicated_argument";
  readonly statement: string;
  readonly epistemicKind: string;
  readonly valence?: string | null;
  readonly evidence: readonly Evidence[];
  readonly memberRevisionIds: readonly string[];
}

/** What one conversation offers verification: its transcript, or passages around its quotes. */
export interface SourcePassages {
  readonly conversationId: string;
  /** Names the conversation in prompts ("Conversation 3"), never a participant's name. */
  readonly label: string;
  readonly transcript?: string | null;
  readonly passages?: readonly string[];
}

const sourceText = (s: SourcePassages) =>
  s.transcript ? s.transcript : (s.passages ?? []).filter(Boolean).join("\n[...]\n");

export interface QuoteRef {
  id: string;
  conversation_id: string;
  text: string;
  location: unknown;
}

export interface PoleSupporter {
  revision_id: string;
  object_id: string;
  member_revision_ids: string[];
  quote_ids: string[];
  strength: number;
  why: string;
}

export interface SupportRelation {
  type: string;
  from_revision_id: string;
  to_tension: string;
  basis: "extracted";
  check: Json;
}

export interface Tension {
  key: string;
  pole_a: string;
  pole_b: string;
  knot: string;
  to_resolve: string;
  quote_ids: string[];
  quotes: QuoteRef[];
  supporters_a: PoleSupporter[];
  supporters_b: PoleSupporter[];
  screen_flags: string[];
  question: string;
}

export interface Coverage {
  arguments: number;
  positions: number;
  conversations: number;
  conversations_with_evidence: number;
  without_evidence: string[];
  without_source: string[];
  evidence_not_found: string[];
  trimmed: string[];
  members_missing: Record<string, string[]>;
  both_poles_skipped: string[];
  rejected_pairs: Json[];
  unsupported: Json[];
  support_rejected: number;
  support_capped: number;
  framing: "assessed" | "not_assessed";
  thin: boolean;
  note: string | null;
}

export interface TensionsResult {
  status: "ok" | "insufficient_coverage";
  input_set: InputSet;
  input_revision_ids: string[];
  tensions: Tension[];
  relations: SupportRelation[];
  quotes: QuoteRef[];
  coverage: Coverage;
  counts: Record<string, number>;
  usage: Json;
  prompt_versions: Record<string, string>;
  gate_flags: string[];
  suggestion: string | null;
  recipe_id: string;
  recipe_version: string;
}

const shortHash = (text: string) => `sha256:${sha256Hex(text).slice(0, 16)}`;

/** Each prompt's declared version, or its content hash; the inline dedupe prompt by hash. */
export function promptVersions(
  prompts: Readonly<Record<string, string>> = PROMPTS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PROMPT_NAMES) {
    const text = prompts[name];
    if (text === undefined) continue;
    const m = /^Version: `([^`]+)`/m.exec(text);
    out[name] = m ? (m[1] as string) : shortHash(text);
  }
  out[DEDUPE_PROMPT_NAME] = shortHash(DEDUPE_SYSTEM);
  return out;
}

// What a judgement is about (its argument revisions and conversations), set per task so
// concurrent judgements do not mix: the recipe keys each judgement's step by it.
const NAMED = new AsyncLocalStorage<Record<string, string[]>>();

export const namedInputs = (): Record<string, string[]> => ({ ...(NAMED.getStore() ?? {}) });

export function naming<T>(
  o: { revisions?: Iterable<string>; conversations?: Iterable<string> },
  fn: () => Promise<T>,
): Promise<T> {
  const named: Record<string, string[]> = {};
  const revisions = sortedStrings(new Set(o.revisions ?? []));
  const conversations = sortedStrings(new Set(o.conversations ?? []));
  if (revisions.length) named.revisionIds = revisions;
  if (conversations.length) named.conversations = conversations;
  return NAMED.run(named, fn);
}

/** Python's asyncio.TaskGroup gather: every result in order, the first failure raised. */
async function gather<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks.map((t) => t()));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value);
}

function chooseInputSet(
  args: readonly ArgumentRevision[],
  sources: readonly SourcePassages[],
  inputSet: InputSet | null,
): InputSet {
  const kinds = new Set(args.map((a) => a.type));
  if ([...kinds].some((k) => k !== "argument" && k !== "deduplicated_argument"))
    throw new Error(`tensions read arguments, not ${sortedStrings(kinds)}`);
  if (kinds.size > 1)
    throw new Error("tensions read one argument set: raw or deduplicated, not both");
  const derived: InputSet | null = !kinds.size
    ? null
    : kinds.has("deduplicated_argument")
      ? "deduplicated"
      : "raw";
  if (inputSet !== null && derived !== null && inputSet !== derived)
    throw new Error(`input set ${pyRepr(inputSet)} does not match the arguments (${derived})`);
  const ids = args.map((a) => a.revisionId);
  if (new Set(ids).size !== ids.length) throw new Error("an argument revision is pinned twice");
  for (const a of args)
    if (a.epistemicKind !== "argument" && a.epistemicKind !== "claim")
      throw new Error(`${a.revisionId}: unknown epistemic kind ${pyRepr(a.epistemicKind)}`);
  const conversations = sources.map((s) => s.conversationId);
  if (new Set(conversations).size !== conversations.length)
    throw new Error("a conversation's source passages are given twice");
  return inputSet ?? derived ?? "raw";
}

// ── grounding ───────────────────────────────────────────────────────────

/** The first conversation in `order` whose text holds the quote as Map grounds it. */
export function groundIn(
  quote: string,
  keys: ReadonlyMap<string, string>,
  order: readonly string[],
): [string, string] | null {
  for (const cid of new Set(order)) {
    const key = keys.get(cid);
    if (key === undefined) continue;
    const grounded = groundQuote(quote, key);
    if (grounded) return [cid, grounded];
  }
  return null;
}

/** The quote ids of one run: grounded quotes only, one id per words per conversation. */
export class QuoteRegistry {
  readonly keys: Map<string, string>;
  readonly quotes: { id: string; transcript: string; text: string }[] = [];
  private readonly seen = new Map<string, string>();

  constructor(texts: ReadonlyMap<string, string>) {
    this.keys = new Map([...texts.entries()].map(([cid, text]) => [cid, normKey(text)]));
  }

  add(quote: Json): string | null {
    const named = String(quote.transcript || "");
    const found = groundIn(String(quote.text || ""), this.keys, [named, ...this.keys.keys()]);
    if (!found) return null;
    const [where, grounded] = found;
    const key = `${where}\x1f${casefold(grounded)}`;
    if (!this.seen.has(key)) {
      const qid = `q${this.quotes.length + 1}`;
      this.quotes.push({ id: qid, transcript: where, text: grounded });
      this.seen.set(key, qid);
    }
    return this.seen.get(key) as string;
  }

  addAll(quotes: readonly unknown[]): string[] {
    const ids: string[] = [];
    for (const q of quotes ?? []) {
      const qid = q && typeof q === "object" && !Array.isArray(q) ? this.add(q as Json) : null;
      if (qid && !ids.includes(qid)) ids.push(qid);
    }
    return ids;
  }
}

// ── positions ───────────────────────────────────────────────────────────

function holder(tables: string[], labels: ReadonlyMap<string, string>): string {
  const names = tables.map((t) => labels.get(t) || t);
  if (names.length === 1) return `a speaker in ${names[0]}`;
  if (names.length === 2) return `speakers in ${names[0]} and ${names[1]}`;
  return `speakers in ${names.length} conversations`;
}

export function emptyCoverage(args: number, conversations: number): Coverage {
  return {
    arguments: args,
    positions: 0,
    conversations,
    conversations_with_evidence: 0,
    without_evidence: [],
    without_source: [],
    evidence_not_found: [],
    trimmed: [],
    members_missing: {},
    both_poles_skipped: [],
    rejected_pairs: [],
    unsupported: [],
    support_rejected: 0,
    support_capped: 0,
    framing: "not_assessed",
    thin: false,
    note: null,
  };
}

/** Every argument with grounded evidence in a conversation at hand becomes a position, with no call. */
export function positionsFromArguments(
  args: readonly ArgumentRevision[],
  sources: readonly SourcePassages[],
  members: readonly ArgumentRevision[] = [],
): [Json[], Coverage] {
  const order = sources.map((s) => s.conversationId);
  const texts = new Map(
    sources.filter((s) => sourceText(s)).map((s) => [s.conversationId, sourceText(s)]),
  );
  const keys = new Map([...texts.entries()].map(([cid, text]) => [cid, normKey(text)]));
  const labels = new Map(sources.map((s) => [s.conversationId, s.label]));
  const byMember = new Map(members.map((m) => [m.revisionId, m]));
  const coverage = emptyCoverage(args.length, sources.length);
  const positions: Json[] = [];
  for (const arg of args) {
    let evidence = [...arg.evidence];
    const missing: string[] = [];
    for (const mid of arg.memberRevisionIds) {
      const member = byMember.get(mid);
      if (!member) missing.push(mid);
      else evidence.push(...member.evidence);
    }
    if (missing.length) coverage.members_missing[arg.revisionId] = missing;
    evidence = evidence.filter((e) => e.quote.trim());
    if (!evidence.length) {
      coverage.without_evidence.push(arg.revisionId);
      continue;
    }
    const named = [...new Set(evidence.map((e) => e.conversationId))];
    const available = order.filter((c) => named.includes(c) && texts.has(c));
    if (!available.length) {
      coverage.without_source.push(arg.revisionId);
      continue;
    }
    const found: Json[] = [];
    const seen = new Set<string>();
    for (const e of evidence) {
      if (!texts.has(e.conversationId)) continue;
      const located = groundIn(e.quote, keys, [e.conversationId, ...available]);
      if (!located) continue;
      const [where, grounded] = located;
      const k = `${where}\x1f${casefold(grounded)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      found.push({
        transcript: where,
        text: grounded,
        location: where === e.conversationId ? (e.location ?? null) : null,
      });
    }
    if (!found.length) {
      coverage.evidence_not_found.push(arg.revisionId);
      continue;
    }
    const own = String(found[0]?.transcript);
    const tables = [own, ...available.filter((c) => c !== own)];
    positions.push({
      revision_id: arg.revisionId,
      object_id: arg.objectId,
      member_revision_ids: [...arg.memberRevisionIds],
      position: arg.statement.trim(),
      holder: holder(tables, labels),
      kind: arg.epistemicKind,
      hedged: HEDGED.test(arg.statement),
      quote: found[0]?.text,
      transcript: own,
      tables,
      verbatim: true,
      evidence: found,
    });
  }
  coverage.conversations_with_evidence = new Set(
    positions.flatMap((p) => (p.evidence as Json[]).map((q) => String(q.transcript))),
  ).size;
  return [positions, coverage];
}

/** Popcorn's fair cap over positions grouped by their own conversation, numbered P1, P2, ... */
function trim(positions: Json[], order: string[], cap: number): [Json[], string[]] {
  const grouped = new Map<string, Json[]>(order.map((c) => [c, []]));
  for (const p of positions) {
    const t = String(p.transcript);
    if (!grouped.has(t)) grouped.set(t, []);
    grouped.get(t)?.push(p);
  }
  const kept = trimPositions(grouped, cap);
  const keptSet = new Set([...kept.values()].flat());
  const trimmed = positions.filter((p) => !keptSet.has(p)).map((p) => String(p.revision_id));
  const numbered: Json[] = [];
  for (const items of kept.values())
    for (const p of items) numbered.push({ id: `P${numbered.length + 1}`, ...p });
  return [numbered, trimmed];
}

// ── 2. collisions ───────────────────────────────────────────────────────

function tableKeys(positions: readonly Json[], tables: readonly string[]): Map<string, string> {
  const order = [...tables];
  for (const p of positions)
    for (const tid of tablesOf(p)) if (!order.includes(tid)) order.push(tid);
  return new Map(order.map((t, i) => [t, `T${i + 1}`]));
}

export function listing(positions: readonly Json[], tables: readonly string[]): string {
  const key = tableKeys(positions, tables);
  return positions
    .map(
      (p) =>
        `${p.id} [${key.get(String(p.transcript))} · ${pyStr(p.holder)} · ${pyStr(p.kind)}${p.hedged ? " · hedged" : ""}] ${p.position}`,
    )
    .join("\n");
}

const pyFloat = (v: unknown): number | null => {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return 0;
  if (v === true) return 1;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return v.trim() !== "" && !Number.isNaN(n) ? n : null;
  }
  return null;
};

export async function findCollisions(
  judge: Judge,
  positions: readonly Json[],
  o: {
    prompt: string;
    tables: readonly string[];
    batch?: number;
    maxCandidates?: number;
    maxPerPosition?: number;
  },
): Promise<[Json[], number]> {
  const batch = o.batch ?? FOCAL_BATCH;
  const maxCandidates = o.maxCandidates ?? MAX_CANDIDATES;
  const maxPerPosition = o.maxPerPosition ?? MAX_PAIRS_PER_POSITION;
  const byId = new Map(positions.map((p) => [String(p.id), p]));
  const rank = new Map(positions.map((p, i) => [String(p.id), i]));
  const listed = dataBlock("ARGUMENTS", listing(positions, o.tables));
  const ids = positions.map((p) => String(p.id));
  const ask = (focal: string[]) => async (): Promise<[string[], Json[]]> => {
    const out = await naming(
      { revisions: focal.map((pid) => String(byId.get(pid)?.revision_id)) },
      () =>
        judge.call(
          o.prompt,
          `${listed}\n\nFOCAL POSITIONS: ${focal.join(", ")}`,
          COLLISIONS_SCHEMA,
          { label: "collisions" },
        ),
    );
    return [
      focal,
      ((out.collisions as unknown[]) ?? []).filter(
        (c): c is Json => !!c && typeof c === "object" && !Array.isArray(c),
      ),
    ];
  };
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batch) batches.push(ids.slice(i, i + batch));
  const pairs = new Map<string, Json>();
  for (const [focal, found] of await gather(batches.map(ask))) {
    for (const c of found) {
      const pid = String(c.focal || "").trim();
      const other = String(c.other || "").trim();
      if (!focal.includes(pid) || !byId.has(other) || other === pid) continue;
      const score = pyFloat(c.zero_sum);
      if (score === null) continue;
      if (score < MIN_ZERO_SUM) continue;
      const [a, b] = [pid, other].sort(
        (x, y) => (rank.get(x) as number) - (rank.get(y) as number),
      ) as [string, string];
      const key = `${a}|${b}`;
      const prev = pairs.get(key);
      if (!prev || score > (prev.zero_sum as number)) {
        const ta = new Set(tablesOf(byId.get(a) as Json));
        const tb = new Set(tablesOf(byId.get(b) as Json));
        pairs.set(key, {
          a,
          b,
          zero_sum: score,
          why: String(c.why || ""),
          question: String(c.question || "").trim(),
          cross_table: !(ta.size === tb.size && [...ta].every((x) => tb.has(x))),
          named_by: [...((prev?.named_by as string[]) ?? []), pid],
        });
      } else (prev.named_by as string[]).push(pid);
    }
  }
  const orderKey = (c: Json): number[] => [
    c.cross_table ? 0 : 1,
    -(c.zero_sum as number),
    -(c.named_by as string[]).length,
    rank.get(String(c.a)) as number,
    rank.get(String(c.b)) as number,
  ];
  const cmp = (x: Json, y: Json) => {
    const a = orderKey(x);
    const b = orderKey(y);
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    return 0;
  };
  const ranked = [...pairs.values()].sort(cmp);
  const uses = new Map<string, number>();
  const chosen: Json[] = [];
  const take = (c: Json): boolean => {
    if (
      chosen.includes(c) ||
      (uses.get(String(c.a)) ?? 0) >= maxPerPosition ||
      (uses.get(String(c.b)) ?? 0) >= maxPerPosition
    )
      return false;
    chosen.push(c);
    for (const x of [String(c.a), String(c.b)]) uses.set(x, (uses.get(x) ?? 0) + 1);
    return true;
  };
  // The best pair of every conversation is verified whatever its rank; the rest fill by rank.
  const seenTids = new Set<string>();
  for (const c of ranked) {
    const tids = [
      ...tablesOf(byId.get(String(c.a)) as Json),
      ...tablesOf(byId.get(String(c.b)) as Json),
    ];
    if (tids.some((t) => !seenTids.has(t)) && take(c)) for (const t of tids) seenTids.add(t);
  }
  for (const c of ranked) {
    if (chosen.length >= maxCandidates) break;
    take(c);
  }
  chosen.sort(cmp);
  return [chosen, ranked.length];
}

// ── 3. verification ─────────────────────────────────────────────────────

const said = (position: Json) =>
  (position.evidence as Json[])
    .slice(0, QUOTES_PER_POLE)
    .map((q) => `   said: "${q.text}"`)
    .join("\n");

export async function verifyCandidates(
  judge: Judge,
  candidates: readonly Json[],
  byId: ReadonlyMap<string, Json>,
  o: { prompt: string; transcripts: Readonly<Record<string, string>>; handedText: string },
): Promise<Json[]> {
  const verify = (c: Json) => async (): Promise<Json> => {
    const a = byId.get(String(c.a)) as Json;
    const b = byId.get(String(c.b)) as Json;
    const ts = sortedStrings(new Set([...tablesOf(a), ...tablesOf(b)]));
    const user =
      `${corpus(o.transcripts, ts)}\n\nWHAT THE ROOMS WERE HANDED:\n${o.handedText}\n\n` +
      `FLAGGED ON THE QUESTION: ${c.question || "(none named)"}\n` +
      `Flagged because: ${c.why}\n\n` +
      `THE PAIR:\nA (${pyStr(a.holder)}, ${pyStr(a.kind)}): ${a.position}\n${said(a)}\n` +
      `B (${pyStr(b.holder)}, ${pyStr(b.kind)}): ${b.position}\n${said(b)}`;
    const out = await naming(
      { revisions: [String(a.revision_id), String(b.revision_id)], conversations: ts },
      () => judge.call(o.prompt, user, VERIFY_SCHEMA, { label: "verify" }),
    );
    const poleA = String(out.poleA || "").trim();
    const poleB = String(out.poleB || "").trim();
    const question = String(out.question || "").trim();
    const opposed = Boolean(out.opposed);
    return {
      ...c,
      valid: Boolean(out.valid) && opposed && Boolean(poleA && poleB && question),
      opposed,
      question: question || c.question,
      verify_why: String(out.reason || "").trim(),
      poleA,
      poleB,
      quotesA: (a.evidence as Json[]).slice(0, QUOTES_PER_POLE),
      quotesB: (b.evidence as Json[]).slice(0, QUOTES_PER_POLE),
      transcripts: ts,
    };
  };
  return gather(candidates.map(verify));
}

// ── 5. support ──────────────────────────────────────────────────────────

export async function confirmSupport(
  judge: Judge,
  kept: readonly Json[],
  byId: ReadonlyMap<string, Json>,
  o: { prompt: string; maxSupporters?: number },
): Promise<Json[]> {
  const maxSupporters = o.maxSupporters ?? MAX_SUPPORTERS_PER_POLE;
  const confirm = (k: Json) => async (): Promise<Json> => {
    const proposed = new Map<string, Json>();
    for (const side of ["A", "B"])
      for (const s of k[`support${side}`] as Json[])
        if (!proposed.has(String(s.position))) proposed.set(String(s.position), s);
    for (const pid of (k.both_poles as string[] | undefined) ?? [])
      if (!proposed.has(pid))
        proposed.set(pid, {
          position: pid,
          pair: [k.a, k.b],
          via: "facet",
          verify_why: k.verify_why,
        });
    const ids = [...proposed.keys()].filter((pid) => byId.has(pid));
    const lines: string[] = [];
    for (const pid of ids) {
      const p = byId.get(pid) as Json;
      lines.push(`${pid} [${pyStr(p.kind)}] ${p.position}`);
      lines.push(said(p));
    }
    const user = `QUESTION: ${k.question}\nPOLE A: ${k.poleA}\nPOLE B: ${k.poleB}\n\n${dataBlock("ARGUMENTS", lines.join("\n"))}`;
    const out = await naming(
      { revisions: ids.map((pid) => String(byId.get(pid)?.revision_id)) },
      () => judge.call(o.prompt, user, SUPPORT_SCHEMA, { label: "support" }),
    );
    const answers = new Map<string, Json>();
    for (const entry of (out.supporters as unknown[]) ?? []) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Json;
      const pid = String(e.id || "").trim();
      if (!proposed.has(pid) || answers.has(pid)) continue;
      const raw = pyFloat(e.strength);
      const strength = raw === null ? 0 : Math.min(1, Math.max(0, raw));
      const pole = e.pole;
      answers.set(pid, {
        pole: pole === "A" || pole === "B" ? pole : "neither",
        strength,
        why: String(e.why || "").trim(),
      });
    }
    const confirmed: Record<string, Json[]> = { A: [], B: [] };
    const rejected: Json[] = [];
    ids.forEach((pid, index) => {
      const answer = answers.get(pid);
      if (
        !answer ||
        answer.pole === "neither" ||
        (answer.strength as number) < MIN_SUPPORT_STRENGTH
      ) {
        rejected.push({ position: pid, ...(answer ?? { pole: "unanswered" }) });
        return;
      }
      (confirmed[String(answer.pole)] as Json[]).push({
        ...proposed.get(pid),
        position: pid,
        pole: answer.pole,
        strength: answer.strength,
        support_why: answer.why,
        proposed_order: index,
      });
    });
    const capped: string[] = [];
    for (const side of ["A", "B"]) {
      const ranked = [...(confirmed[side] as Json[])].sort(
        (x, y) =>
          (y.strength as number) - (x.strength as number) ||
          (x.proposed_order as number) - (y.proposed_order as number),
      );
      confirmed[side] = ranked.slice(0, maxSupporters);
      capped.push(...ranked.slice(maxSupporters).map((s) => String(s.position)));
    }
    const onA = new Set((confirmed.A as Json[]).map((s) => s.position));
    const onB = new Set((confirmed.B as Json[]).map((s) => s.position));
    let problem: string | null = null;
    if (onB.has(k.a) || onA.has(k.b))
      problem = "the support check put the pair's own arguments on the opposite poles";
    else if (!onA.size || !onB.size) problem = "a pole has no confirmed supporting argument";
    return {
      ...k,
      confirmedA: confirmed.A,
      confirmedB: confirmed.B,
      support_rejected: rejected,
      support_capped: capped,
      support_problem: problem,
    };
  };
  return gather(kept.map(confirm));
}

// ── 6. writing, with a completeness gate ────────────────────────────────

const ELLIPSIS = /\.\.\.|…/u;
const ELIDED = /(?:^|[;:,]\s*)(?:don't|don’t|dont|do not|not|otherwise)\s*[,;.]/iu;
const CLAUSE_BREAK = /[;:]|\s[-–—]\s/u;
const PAYS_BOTH = new RegExp(`[;,]|${WB_START}(?:and|but|while|whereas|or)${WB_END}`, "iu");
const REPEATED = new RegExp(`${WB_START}(${W}+)\\s+\\1${WB_END}`, "iu");
const TRAILING = /[^\p{L}\p{N}_']+$/u;
const DANGLING = new Set([
  "and",
  "or",
  "but",
  "because",
  "so",
  "to",
  "the",
  "a",
  "an",
  "of",
  "with",
  "without",
  "if",
  "while",
  "than",
]);

/** What the screen gate does not catch: a knot or question that is not a finished, whole sentence. */
export function completenessFlags(tension: Json): string[] {
  const tid = tension.id ?? "?";
  const flags: string[] = [];
  for (const name of ["poleA", "poleB", "knot", "toResolve"])
    if (ELLIPSIS.test(String(tension[name] ?? "")))
      flags.push(`${tid} ${name}: has an ellipsis; write it out in full`);
  const knot = String(tension.knot ?? "").trim();
  const question = String(tension.toResolve ?? "").trim();
  if (knot) {
    if (!(knot.endsWith(".") || knot.endsWith("!")))
      flags.push(`${tid} knot: not a finished sentence ending in a full stop: ${pyRepr(knot)}`);
    const elided = ELIDED.exec(knot);
    if (elided)
      flags.push(
        `${tid} knot: an elided clause (${pyRepr(stripChars(elided[0], " ;:,"))}); give every clause its own subject and verb: ${pyRepr(knot)}`,
      );
    for (const clause of knot.split(CLAUSE_BREAK)) {
      const n = pySplit(clause).length;
      if (n > 0 && n < 3)
        flags.push(`${tid} knot: ${pyRepr(clause.trim())} is not a whole clause: ${pyRepr(knot)}`);
    }
    if (!PAYS_BOTH.test(knot))
      flags.push(`${tid} knot: does not say what each side pays: ${pyRepr(knot)}`);
    if ((knot.split('"').length - 1) % 2 || knot.split("(").length !== knot.split(")").length)
      flags.push(`${tid} knot: unbalanced quotation marks or brackets: ${pyRepr(knot)}`);
    const repeated = REPEATED.exec(knot);
    if (repeated) flags.push(`${tid} knot: ${pyRepr(repeated[0])} repeats a word: ${pyRepr(knot)}`);
  }
  if (question && !question.endsWith("?"))
    flags.push(`${tid} toResolve: not a question ending in a question mark: ${pyRepr(question)}`);
  for (const [name, text] of [
    ["knot", knot],
    ["toResolve", question],
  ] as const) {
    const ws = pySplit(text.replace(TRAILING, ""));
    const last = ws[ws.length - 1];
    if (last && DANGLING.has(casefold(last)))
      flags.push(`${tid} ${name}: ends on ${pyRepr(last)}: ${pyRepr(text)}`);
  }
  return flags;
}

function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a] as string)) a++;
  while (b > a && chars.includes(s[b - 1] as string)) b--;
  return s.slice(a, b);
}

export const writeFlags = (t: Json) => [...screenFlags([t]), ...completenessFlags(t)];

const holding = (supporters: readonly Json[], byId: ReadonlyMap<string, Json>) =>
  supporters
    .filter((s) => ((byId.get(String(s.position))?.evidence as Json[]) ?? []).length)
    .map((s) => `"${((byId.get(String(s.position)) as Json).evidence as Json[])[0]?.text}"`)
    .join(" | ");

export async function writeTensions(
  judge: Judge,
  items: readonly Json[],
  byId: ReadonlyMap<string, Json>,
  o: { prompt: string; hostNote?: string },
): Promise<[Json, string[]][]> {
  const write = (k: Json) => async (): Promise<[Json, string[]]> => {
    const facets = ((k.merged as Json[] | undefined) ?? [])
      .filter((m) => byId.has(String(m.a)) && byId.has(String(m.b)))
      .map((m) => `- ${byId.get(String(m.a))?.position}  /  ${byId.get(String(m.b))?.position}`);
    const note = o.hostNote
      ? `HOST NOTE ON VOICE (from the facilitator; every rule above still holds):\n${o.hostNote}\n\n`
      : "";
    const user =
      `${note}QUESTION: ${k.question}\nPOLE A: ${k.poleA}\nPOLE B: ${k.poleB}\n` +
      `HOLDING A: ${holding(k.confirmedA as Json[], byId)}\n` +
      `HOLDING B: ${holding(k.confirmedB as Json[], byId)}\n` +
      `WHAT COLLIDES: ${k.why}` +
      (facets.length
        ? `\nFACETS OF THE SAME PULL, FOUND IN OTHER ROOMS (a middle course among them belongs in the knot, not as a resolution but as what the room reached for):\n${facets.join("\n")}`
        : "");
    const shaped = (out: Json): Json => ({
      id: k.id,
      poleA: String(out.poleA || "").trim() || k.poleA,
      poleB: String(out.poleB || "").trim() || k.poleB,
      knot: String(out.knot || "").trim(),
      toResolve: String(out.toResolve || "").trim(),
    });
    const supporters = [...(k.confirmedA as Json[]), ...(k.confirmedB as Json[])];
    return naming(
      { revisions: supporters.map((s) => String(byId.get(String(s.position))?.revision_id)) },
      async () => {
        let t = shaped(await judge.call(o.prompt, user, WRITE_SCHEMA, { label: "write" }));
        let flags = writeFlags(t);
        if (flags.length) {
          const retry = `${o.prompt}\n\n## Your previous answer failed these checks\n\n${flags.map((f) => `- ${f}`).join("\n")}\n\nFix every one of them.`;
          t = shaped(await judge.call(retry, user, WRITE_SCHEMA, { label: "write" }));
          flags = writeFlags(t);
        }
        return [t, flags] as [Json, string[]];
      },
    );
  };
  return gather(items.map(write));
}

// ── the pipeline ────────────────────────────────────────────────────────

export interface RunOptions {
  readonly generate: Generate;
  readonly retryable?: (err: unknown) => boolean;
  readonly prompts?: Readonly<Record<string, string>>;
  readonly members?: readonly ArgumentRevision[];
  readonly inputSet?: InputSet | null;
  readonly hostNote?: string;
  readonly framing?: boolean | null;
  readonly concurrency?: number;
  readonly maxTensions?: number;
  readonly maxPositions?: number;
  readonly minConversations?: number;
  readonly focalBatch?: number;
  readonly maxCandidates?: number;
  readonly maxPairsPerPosition?: number;
  readonly maxSupporters?: number;
  readonly clock?: () => number;
}

export async function runTensions(
  args: readonly ArgumentRevision[],
  sources: readonly SourcePassages[],
  o: RunOptions,
): Promise<TensionsResult> {
  const chosen = chooseInputSet(args, sources, o.inputSet ?? null);
  const prompts = o.prompts ?? PROMPTS;
  const versions = promptVersions(prompts);
  const clock = o.clock ?? Date.now;
  const started = clock();
  const order = sources.map((s) => s.conversationId);
  const texts = new Map(
    sources.filter((s) => sourceText(s)).map((s) => [s.conversationId, sourceText(s)]),
  );
  const textsObj = Object.fromEntries(texts);
  const full = new Set(sources.filter((s) => Boolean(s.transcript)).map((s) => s.conversationId));
  const minConversations = o.minConversations ?? MIN_CONVERSATIONS;

  let [positions, coverage] = positionsFromArguments(args, sources, o.members ?? []);
  [positions, coverage.trimmed] = trim(positions, order, o.maxPositions ?? MAX_POSITIONS);
  coverage.positions = positions.length;
  const byId = new Map(positions.map((p) => [String(p.id), p]));
  const inPlay = order.filter((c) => positions.some((p) => (p.tables as string[]).includes(c)));
  const judge = new Judge(o.generate, o.concurrency ?? 8, o.retryable);
  const counts: Record<string, number> = { arguments: args.length, positions: positions.length };

  const result = (
    status: "ok" | "insufficient_coverage",
    extra: Partial<TensionsResult> = {},
  ): TensionsResult => {
    const needsRefresh =
      coverage.thin ||
      coverage.without_evidence.length > 0 ||
      coverage.without_source.length > 0 ||
      coverage.evidence_not_found.length > 0;
    return {
      status,
      input_set: chosen,
      input_revision_ids: args.map((a) => a.revisionId),
      coverage,
      counts,
      usage: {
        calls: judge.calls,
        retries: judge.retries,
        calls_by_stage: { ...judge.byLabel },
        wall_ms: Math.trunc(clock() - started),
        tokens: null,
      },
      prompt_versions: versions,
      suggestion: needsRefresh ? SUGGEST_REFRESH : null,
      tensions: [],
      relations: [],
      quotes: [],
      gate_flags: [],
      recipe_id: RECIPE_ID,
      recipe_version: RECIPE_VERSION,
      ...extra,
    };
  };

  if (coverage.conversations_with_evidence < minConversations || positions.length < 2) {
    coverage.thin = true;
    coverage.note =
      `${coverage.conversations_with_evidence} conversation(s) have arguments whose ` +
      `evidence was found in their source; tensions need at least ${minConversations}. ` +
      "Refresh the arguments, or add source passages for the conversations listed.";
    return result("insufficient_coverage");
  }

  const assess = o.framing ?? inPlay.every((c) => full.has(c));
  coverage.framing = assess ? "assessed" : "not_assessed";
  const needed = ["collisions", "verify", "support", "write", ...(assess ? ["handed"] : [])];
  const missing = needed.filter((n) => !(n in prompts));
  if (missing.length) throw new Error(`missing prompts: ${missing}`);

  // 1 and 2 beside each other: collisions do not read the handed list.
  const [handed, [candidates, foundPairs]] = await Promise.all([
    assess
      ? naming({ conversations: inPlay.filter((c) => full.has(c)) }, () =>
          findHanded(
            judge,
            Object.fromEntries(
              inPlay.filter((c) => full.has(c)).map((c) => [c, texts.get(c) as string]),
            ),
            prompts.handed as string,
          ),
        )
      : Promise.resolve([] as Json[]),
    findCollisions(judge, positions, {
      prompt: prompts.collisions as string,
      tables: order,
      batch: o.focalBatch ?? FOCAL_BATCH,
      maxCandidates: o.maxCandidates ?? MAX_CANDIDATES,
      maxPerPosition: o.maxPairsPerPosition ?? MAX_PAIRS_PER_POSITION,
    }),
  ]);
  const handedText = assess ? handedListing(handed) : NOT_ASSESSED;

  const verified = await verifyCandidates(judge, candidates, byId, {
    prompt: prompts.verify as string,
    transcripts: textsObj,
    handedText,
  });
  const valid = verified.filter((v) => v.valid);
  coverage.rejected_pairs = verified
    .filter((v) => !v.valid)
    .map((v) => ({
      pair: [byId.get(String(v.a))?.revision_id, byId.get(String(v.b))?.revision_id],
      opposed: v.opposed,
      reason: v.verify_why,
    }));

  const kept = await dedupeTensions(judge, valid, o.maxTensions ?? MAX_TENSIONS);
  const bothPoles = kept.flatMap((k) =>
    ((k.both_poles as string[] | undefined) ?? []).map((pid) => String(byId.get(pid)?.revision_id)),
  );
  coverage.both_poles_skipped = [...new Set(bothPoles)];

  const checked = await confirmSupport(judge, kept, byId, {
    prompt: prompts.support as string,
    maxSupporters: o.maxSupporters ?? MAX_SUPPORTERS_PER_POLE,
  });
  const supported = checked.filter((k) => !k.support_problem);
  coverage.unsupported = checked
    .filter((k) => k.support_problem)
    .map((k) => ({
      poles: [k.poleA, k.poleB],
      pair: [byId.get(String(k.a))?.revision_id, byId.get(String(k.b))?.revision_id],
      reason: k.support_problem,
    }));
  coverage.support_rejected = checked.reduce(
    (n, k) => n + (k.support_rejected as unknown[]).length,
    0,
  );
  coverage.support_capped = checked.reduce((n, k) => n + (k.support_capped as unknown[]).length, 0);

  const written = await writeTensions(judge, supported, byId, {
    prompt: prompts.write as string,
    hostNote: o.hostNote ?? "",
  });

  const book = new QuoteRegistry(texts);
  const locations = new Map<string, unknown>();
  for (const p of positions)
    for (const q of p.evidence as Json[])
      locations.set(`${q.transcript}\x1f${casefold(String(q.text))}`, q.location ?? null);
  const tensions: Tension[] = [];
  const relations: SupportRelation[] = [];
  const gateFlags: string[] = [];
  let unsupportedGate = 0;
  written.forEach(([writtenTension, flags], i) => {
    const item = supported[i] as Json;
    const key = `x${tensions.length + 1}`;
    const supporters: Record<string, PoleSupporter[]> = { A: [], B: [] };
    const deck: Record<string, string[]> = { A: [], B: [] };
    const pending: SupportRelation[] = [];
    for (const side of ["A", "B"]) {
      for (const s of item[`confirmed${side}`] as Json[]) {
        const p = byId.get(String(s.position)) as Json;
        const quoteIds = book.addAll(p.evidence as Json[]);
        (supporters[side] as PoleSupporter[]).push({
          revision_id: String(p.revision_id),
          object_id: String(p.object_id),
          member_revision_ids: [...(p.member_revision_ids as string[])],
          quote_ids: quoteIds,
          strength: s.strength as number,
          why: String(s.support_why),
        });
        const check: Json = {
          step: "support",
          prompt: versions.support,
          strength: s.strength,
          why: s.support_why,
          via: s.via ?? null,
          pair: ((s.pair as string[] | undefined) ?? [])
            .filter((x) => byId.has(x))
            .map((x) => byId.get(x)?.revision_id),
          verify: s.verify_why || item.verify_why,
          question: item.question,
          evidence: "argument evidence grounded in its source",
        };
        if (s.via === "facet")
          check.dedupe = {
            prompt: versions[DEDUPE_PROMPT_NAME],
            why: s.dedupe_why ?? "",
            swapped: Boolean(s.swapped),
          };
        pending.push({
          type: RELATION_BY_POLE[side] as string,
          from_revision_id: String(p.revision_id),
          to_tension: key,
          basis: "extracted",
          check,
        });
      }
    }
    for (const side of ["A", "B"]) {
      // The deck's quotes: every supporter's first quote, strongest first, then their second.
      for (let round = 0; round < QUOTES_PER_POLE; round++)
        for (const supporter of supporters[side] as PoleSupporter[]) {
          const d = deck[side] as string[];
          if (d.length >= QUOTES_PER_POLE || round >= supporter.quote_ids.length) continue;
          const qid = supporter.quote_ids[round] as string;
          if (!d.includes(qid)) d.push(qid);
        }
    }
    if (!((deck.A as string[]).length && (deck.B as string[]).length)) {
      unsupportedGate++;
      return;
    }
    relations.push(...pending);
    tensions.push({
      key,
      pole_a: String(writtenTension.poleA),
      pole_b: String(writtenTension.poleB),
      knot: String(writtenTension.knot),
      to_resolve: String(writtenTension.toResolve),
      quote_ids: [
        ...(deck.A as string[]),
        ...(deck.B as string[]).filter((q) => !(deck.A as string[]).includes(q)),
      ],
      quotes: [],
      supporters_a: supporters.A as PoleSupporter[],
      supporters_b: supporters.B as PoleSupporter[],
      screen_flags: [...flags],
      question: String(item.question),
    });
    gateFlags.push(...flags);
  });

  const refs = new Map<string, QuoteRef>(
    book.quotes.map((q) => [
      q.id,
      {
        id: q.id,
        conversation_id: q.transcript,
        text: q.text,
        location: locations.get(`${q.transcript}\x1f${casefold(q.text)}`) ?? null,
      },
    ]),
  );
  for (const t of tensions)
    t.quotes = t.quote_ids.filter((id) => refs.has(id)).map((id) => refs.get(id) as QuoteRef);
  Object.assign(counts, {
    handed: handed.length,
    handed_verified: handed.filter((h) => h.verified).length,
    candidates: candidates.length,
    found_pairs: foundPairs,
    cross_table: candidates.filter((c) => c.cross_table).length,
    verified: valid.length,
    rejected: coverage.rejected_pairs.length,
    merged: kept.reduce((n, k) => n + ((k.merged as unknown[] | undefined) ?? []).length, 0),
    both_poles_skipped: bothPoles.length,
    kept: kept.length,
    unsupported_after_support: coverage.unsupported.length,
    support_rejected: coverage.support_rejected,
    support_capped: coverage.support_capped,
    unsupported_gate: unsupportedGate,
    flagged: tensions.filter((t) => t.screen_flags.length).length,
    tensions: tensions.length,
  });
  return result("ok", { tensions, relations, quotes: [...refs.values()], gate_flags: gateFlags });
}
