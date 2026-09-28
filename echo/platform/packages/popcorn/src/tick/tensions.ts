import { popcornShared } from "@echo/analysis";
import { isRecord, type Json, list, orStr, pyStr, truthy } from "../py";
import { norm, pyStrip } from "../text";
import { screenFlags } from "./gates";
import type { QuoteBook } from "./shapes";
import { all, Semaphore, TickTimeout, withTimeout } from "./util";

/**
 * Tensions as a pipeline of single judgements (popcorn tensions.py): handed, positions,
 * collisions, verify, dedupe, write. Every call is one judgement, bounded and tried twice.
 * Evidence is the contract: a verified pair keeps only quotes word for word in one of its
 * two transcripts, and a pair with no quote on either pole never reaches the deck. The
 * limits, schemas, dedupe prompt and positions cap are the tensions recipe's own.
 */

export const PROMPT_NAMES = [
  "positions",
  "collisions",
  "tension-verify",
  "tension-write",
  "tensions-handed",
] as const;
const MAX_POSITIONS_PER_TRANSCRIPT = 30;
const MAX_CANDIDATES = 40;
// Every position is one collisions call and every pair one verification call, so the
// stages are bounded in code (MAX_POSITIONS_TOTAL) rather than in the prompts.
export const {
  CALL_TIMEOUT_MS,
  DEDUPE_SCHEMA,
  DEDUPE_SYSTEM,
  HANDED_SCHEMA,
  MAX_POSITIONS_TOTAL,
  MAX_QUOTES_PER_TENSION,
  MAX_TENSIONS,
  MIN_ZERO_SUM,
  TENSION_WRITE_SCHEMA: WRITE_SCHEMA,
  trimPositions,
} = popcornShared;

const POSITIONS_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["positions"],
  properties: {
    positions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["position", "holder", "kind", "hedged", "quote"],
        properties: {
          position: { type: "string", maxLength: 200 },
          holder: { type: "string", maxLength: 80 },
          kind: { type: "string", enum: ["want", "constraint", "value"] },
          hedged: { type: "boolean" },
          quote: { type: "string", maxLength: 400 },
        },
      },
    },
  },
};
const COLLISIONS_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["collides"],
  properties: {
    collides: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "why", "zero_sum"],
        properties: {
          id: { type: "string", maxLength: 12 },
          why: { type: "string", maxLength: 240 },
          zero_sum: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};
const VERIFY_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["valid", "why", "poleA", "poleB", "quotesA", "quotesB"],
  properties: {
    valid: { type: "boolean" },
    why: { type: "string", maxLength: 300 },
    poleA: { type: "string", maxLength: 60 },
    poleB: { type: "string", maxLength: 60 },
    quotesA: { type: "array", items: { type: "string", maxLength: 400 } },
    quotesB: { type: "array", items: { type: "string", maxLength: 400 } },
  },
};

/** One analysis judgement: the caller's prompt and schema, thinking unless told not to. */
export type Generate = (o: {
  system: string;
  user: string;
  schema: Json;
  thinking: boolean;
}) => Promise<Json>;

/** An answer that did not parse: the judge asks again, as the Python did on ValueError. */
export class AnswerError extends Error {}

function corpus(transcripts: ReadonlyMap<string, string>, tids: readonly string[]): string {
  return tids
    .map((t) => `TRANSCRIPT id: ${t}\n${transcripts.get(t) ?? ""}\nEND TRANSCRIPT ${t}`)
    .join("\n\n");
}

/** The first transcript in `order` holding the quote word for word, or null. */
export function locate(
  quote: string,
  transcripts: ReadonlyMap<string, string>,
  order: readonly string[],
): string | null {
  const key = norm(quote);
  if (!key) return null;
  for (const tid of order) {
    const body = transcripts.get(tid);
    if (body !== undefined && norm(body).includes(key)) return tid;
  }
  return null;
}

function tablesOf(position: Json): string[] {
  const tables = list(position.tables);
  return tables.length ? tables.map((t) => pyStr(t)) : [pyStr(position.transcript)];
}

export class JudgeFailed extends Error {}

/** The model, one bounded judgement at a time per slot, counted in one place, tried twice. */
export class Judge {
  calls = 0;
  retries = 0;
  readonly byLabel: Record<string, number> = {};
  private readonly slots: Semaphore;

  constructor(
    private readonly generate: Generate,
    concurrency = 8,
    private readonly timeoutMs = CALL_TIMEOUT_MS,
  ) {
    this.slots = new Semaphore(concurrency);
  }

  call(
    system: string,
    user: string,
    schema: Json,
    thinking = true,
    label = "model",
  ): Promise<Json> {
    return this.slots.run(async () => {
      for (const attempt of [1, 2]) {
        this.calls++;
        this.byLabel[label] = (this.byLabel[label] ?? 0) + 1;
        try {
          return await withTimeout(
            () => this.generate({ system, user, schema, thinking }),
            this.timeoutMs,
          );
        } catch (err) {
          const timeout = err instanceof TickTimeout;
          if (!timeout && !(err instanceof AnswerError)) throw err;
          if (attempt === 1) {
            this.retries++;
            continue;
          }
          if (timeout)
            throw new JudgeFailed(`${label} call took more than ${this.timeoutMs / 1000} s, twice`);
          throw new JudgeFailed(`${label} call answered badly twice: ${(err as Error).message}`);
        }
      }
      throw new Error("unreachable");
    });
  }
}

async function findHanded(
  judge: Judge,
  transcripts: ReadonlyMap<string, string>,
  prompt: string,
): Promise<Json[]> {
  const tids = [...transcripts.keys()];
  const out = await judge.call(prompt, corpus(transcripts, tids), HANDED_SCHEMA, true, "handed");
  const items: Json[] = [];
  for (const h of list(out.handed)) {
    if (!isRecord(h)) continue;
    const quote = pyStrip(orStr(h.quote));
    const claimed = orStr(h.transcript);
    const where = quote ? locate(quote, transcripts, [claimed, ...tids]) : null;
    items.push({ ...h, transcript: where || claimed, verified: where !== null });
  }
  return items;
}

function handedListing(handed: readonly Json[]): string {
  return (
    handed
      .map(
        (h) =>
          `- [${pyStr(h.status)}] ${pyStr(h.text)}\n  what the rooms did: ${pyStr(h.response)}` +
          (h.verified ? "" : "\n  (its quote was not found in the transcripts)"),
      )
      .join("\n") || "- nothing was handed to the rooms"
  );
}

const sortKey = (c: Json): [number, number, number] => [
  c.cross_table ? 0 : 1,
  -(c.zero_sum as number),
  -(c.named_by as string[]).length,
];
const byRank = (a: Json, b: Json) => {
  const [x, y] = [sortKey(a), sortKey(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** One call per focal position against the listing of all of them, ranked and capped. */
async function findCollisions(
  judge: Judge,
  positions: readonly Json[],
  prompt: string,
  tables: readonly string[],
): Promise<[Json[], number]> {
  const byId = new Map(positions.map((p) => [String(p.id), p]));
  const order = [...tables];
  for (const p of positions)
    for (const tid of tablesOf(p)) if (!order.includes(tid)) order.push(tid);
  const key = new Map(order.map((t, i) => [t, `T${i + 1}`]));
  const listing = positions
    .map(
      (p) =>
        `${p.id} [${key.get(pyStr(p.transcript))} · ${pyStr(p.holder)} · ${pyStr(p.kind)}${truthy(p.hedged) ? " · hedged" : ""}] ${pyStr(p.position)}`,
    )
    .join("\n");
  const collisionsFor = async (p: Json): Promise<[string, Json[]]> => {
    const out = await judge.call(
      prompt,
      `ALL POSITIONS:\n${listing}\n\nFOCAL POSITION: ${p.id}`,
      COLLISIONS_SCHEMA,
      true,
      "collisions",
    );
    return [String(p.id), list(out.collides).filter(isRecord)];
  };
  const pair = new Map<string, Json>();
  for (const [pid, cols] of await all(positions.map(collisionsFor))) {
    for (const c of cols) {
      const other = pyStrip(orStr(c.id));
      const raw = truthy(c.zero_sum) ? c.zero_sum : 0;
      const score = typeof raw === "boolean" ? Number(raw) : Number(raw);
      if (typeof raw === "object" || Number.isNaN(score)) continue;
      if (!byId.has(other) || other === pid || score < MIN_ZERO_SUM) continue;
      const [a, b] = pid < other ? [pid, other] : [other, pid];
      const k = `${a}\u0000${b}`;
      const prev = pair.get(k);
      if (!prev || score > (prev.zero_sum as number)) {
        pair.set(k, {
          a,
          b,
          zero_sum: score,
          why: orStr(c.why),
          cross_table: !sameSet(tablesOf(byId.get(a) as Json), tablesOf(byId.get(b) as Json)),
          named_by: [...(prev ? (prev.named_by as string[]) : []), pid],
        });
      } else (prev.named_by as string[]).push(pid);
    }
  }
  let candidates = [...pair.values()].sort(byRank);
  const foundPairs = candidates.length;
  // The best pair of every transcript is verified whatever its rank.
  const reserved: Json[] = [];
  const seenTids = new Set<string>();
  for (const c of candidates)
    for (const tid of [
      ...tablesOf(byId.get(String(c.a)) as Json),
      ...tablesOf(byId.get(String(c.b)) as Json),
    ])
      if (!seenTids.has(tid)) {
        seenTids.add(tid);
        if (!reserved.includes(c)) reserved.push(c);
      }
  const rest = candidates.filter((c) => !reserved.includes(c));
  candidates = [...reserved, ...rest].slice(0, Math.max(MAX_CANDIDATES, reserved.length));
  candidates.sort(byRank);
  return [candidates, foundPairs];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

async function verifyCandidates(
  judge: Judge,
  candidates: readonly Json[],
  byId: ReadonlyMap<string, Json>,
  prompt: string,
  transcripts: ReadonlyMap<string, string>,
  handedText: string,
): Promise<Json[]> {
  const verify = async (c: Json): Promise<Json> => {
    const a = byId.get(String(c.a)) as Json;
    const b = byId.get(String(c.b)) as Json;
    const ts = [...new Set([...tablesOf(a), ...tablesOf(b)])].sort();
    const user =
      `${corpus(transcripts, ts)}\n\nWHAT THE ROOMS WERE HANDED:\n${handedText}\n\n` +
      `THE PAIR:\nA (${pyStr(a.holder)}, ${pyStr(a.kind)}): ${pyStr(a.position)}\n   said: "${pyStr(a.quote)}"\n` +
      `B (${pyStr(b.holder)}, ${pyStr(b.kind)}): ${pyStr(b.position)}\n   said: "${pyStr(b.quote)}"\n` +
      `Flagged because: ${pyStr(c.why)}`;
    const out = await judge.call(prompt, user, VERIFY_SCHEMA, true, "verify");
    const located = (raw: unknown, own: string, other: string): Json[] => {
      const found: Json[] = [];
      for (const q of list(raw)) {
        const where = typeof q === "string" ? locate(q, transcripts, [own, other]) : null;
        if (where) found.push({ transcript: where, text: q });
      }
      return found.slice(0, 2);
    };
    return {
      ...c,
      valid: truthy(out.valid),
      verify_why: orStr(out.why),
      poleA: pyStrip(orStr(out.poleA)),
      poleB: pyStrip(orStr(out.poleB)),
      quotesA: located(out.quotesA, pyStr(a.transcript), pyStr(b.transcript)),
      quotesB: located(out.quotesB, pyStr(b.transcript), pyStr(a.transcript)),
      transcripts: ts,
    };
  };
  return all(candidates.map(verify));
}

/** A verified yes without a quote on a pole is unsupported. */
function supported(verified: readonly Json[]): [Json[], number] {
  const poles = (v: Json) => truthy(v.valid) && truthy(v.poleA) && truthy(v.poleB);
  const quoted = (v: Json) => list(v.quotesA).length > 0 && list(v.quotesB).length > 0;
  return [
    verified.filter((v) => poles(v) && quoted(v)),
    verified.filter((v) => poles(v) && !quoted(v)).length,
  ];
}

function support(v: Json, position: string, via: string, extra: Json = {}): Json {
  return { position, pair: [v.a, v.b], via, verify_why: v.verify_why, ...extra };
}

/** Dedupe in rank order; kept tensions carry the positions holding each pole. */
async function dedupeTensions(judge: Judge, valid: readonly Json[], maxTensions: number) {
  const kept: Json[] = [];
  const keep = (v: Json) =>
    kept.push({
      ...v,
      id: `x${kept.length + 1}`,
      supportA: [support(v, String(v.a), "pair")],
      supportB: [support(v, String(v.b), "pair")],
    });
  for (const v of valid) {
    if (!kept.length) {
      keep(v);
      continue;
    }
    const listingKept = kept.map((k) => `${k.id}: ${k.poleA} / ${k.poleB}`).join("\n");
    const out = await judge.call(
      DEDUPE_SYSTEM,
      `KEPT:\n${listingKept}\n\nNEW: ${v.poleA} / ${v.poleB}\n  (from: ${v.why})`,
      DEDUPE_SCHEMA,
      false,
      "dedupe",
    );
    const same = pyStrip(orStr(out.same_as));
    const target = same ? kept.find((k) => k.id === same) : undefined;
    if (target) {
      const swapped = truthy(out.swapped);
      const why = orStr(out.why);
      const merged = list(target.merged) as Json[];
      merged.push({ a: v.a, b: v.b, why, swapped });
      target.merged = merged;
      // A facet's quotes stay with the pole they held.
      for (const [side, into] of [
        ["quotesA", swapped ? "quotesB" : "quotesA"],
        ["quotesB", swapped ? "quotesA" : "quotesB"],
      ] as const) {
        for (const q of list(v[side]) as Json[]) {
          const held = [...(target.quotesA as Json[]), ...(target.quotesB as Json[])].map(
            (x) => x.text,
          );
          if (!held.includes(q.text) && held.length < MAX_QUOTES_PER_TENSION)
            (target[into] as Json[]).push(q);
        }
      }
      // ...and so do the positions holding it; one that would move poles is recorded.
      for (const [pid, into] of [
        [String(v.a), swapped ? "supportB" : "supportA"],
        [String(v.b), swapped ? "supportA" : "supportB"],
      ] as const) {
        const other = into === "supportB" ? "supportA" : "supportB";
        if ((target[into] as Json[]).some((s) => s.position === pid)) continue;
        if ((target[other] as Json[]).some((s) => s.position === pid)) {
          const both = list(target.both_poles) as string[];
          both.push(pid);
          target.both_poles = both;
          continue;
        }
        (target[into] as Json[]).push(
          support(v, pid, "facet", { dedupe_why: why, swapped, into: target.id }),
        );
      }
      continue;
    }
    // Full: later pairs can still fold into a kept tension as facets.
    if (kept.length >= maxTensions) continue;
    keep(v);
  }
  return kept;
}

/** The knot and the question of every kept tension, with the screen flags left after one retry. */
async function writeTensions(
  judge: Judge,
  kept: readonly Json[],
  byId: ReadonlyMap<string, Json>,
  prompt: string,
  hostNote = "",
): Promise<[Json, string[]][]> {
  const write = async (k: Json): Promise<[Json, string[]]> => {
    const facets = (list(k.merged) as Json[])
      .filter((m) => byId.has(String(m.a)) && byId.has(String(m.b)))
      .map(
        (m) =>
          `- ${pyStr((byId.get(String(m.a)) as Json).position)}  /  ${pyStr((byId.get(String(m.b)) as Json).position)}`,
      );
    const note = hostNote
      ? `HOST NOTE ON VOICE (from the facilitator; every rule above still holds):\n${hostNote}\n\n`
      : "";
    const user =
      `${note}POLE A: ${k.poleA}\nPOLE B: ${k.poleB}\n` +
      `HOLDING A: ${(k.quotesA as Json[]).map((q) => `"${q.text}"`).join(" | ")}\n` +
      `HOLDING B: ${(k.quotesB as Json[]).map((q) => `"${q.text}"`).join(" | ")}\n` +
      `WHAT COLLIDES: ${k.why}` +
      (facets.length
        ? `\nFACETS OF THE SAME PULL, FOUND IN OTHER ROOMS (a middle course among them belongs in the knot, not as a resolution but as what the room reached for):\n${facets.join("\n")}`
        : "");
    const shaped = (out: Json): Json => {
      const pole = (field: string) => pyStrip(orStr(out[field])) || k[field];
      return {
        id: k.id,
        poleA: pole("poleA"),
        poleB: pole("poleB"),
        knot: pyStrip(orStr(out.knot)),
        toResolve: pyStrip(orStr(out.toResolve)),
      };
    };
    let t = shaped(await judge.call(prompt, user, WRITE_SCHEMA, true, "write"));
    let flags = screenFlags({ tensions: [t] });
    if (flags.length) {
      const retry = `${prompt}\n\n## Your previous answer failed these checks\n\n${flags.map((x) => `- ${x}`).join("\n")}\n\nFix every one of them.`;
      t = shaped(await judge.call(retry, user, WRITE_SCHEMA, true, "write"));
      flags = screenFlags({ tensions: [t] });
    }
    return [t, flags];
  };
  return all(kept.map(write));
}

export interface PipelineResult {
  readonly tensions: Json;
  readonly gate_flags: string[];
  readonly counts: Record<string, number>;
}

/** The pipeline over the session, into the tick's shared quote registry. */
export async function runPipeline(
  transcripts: ReadonlyMap<string, string>,
  book: QuoteBook,
  o: {
    generate: Generate;
    prompts: Readonly<Record<string, string>>;
    concurrency?: number;
    maxTensions?: number;
    callTimeoutMs?: number;
  },
): Promise<PipelineResult> {
  const tids = [...transcripts.keys()];
  const judge = new Judge(o.generate, o.concurrency ?? 8, o.callTimeoutMs);
  const prompts = o.prompts;
  const positionsFor = async (tid: string): Promise<Json[]> => {
    const out = await judge.call(
      prompts.positions as string,
      `TRANSCRIPT id: ${tid}\n${transcripts.get(tid)}\nEND TRANSCRIPT`,
      POSITIONS_SCHEMA,
      true,
      "positions",
    );
    const found: Json[] = [];
    for (const p of list(out.positions).slice(0, MAX_POSITIONS_PER_TRANSCRIPT)) {
      if (!isRecord(p) || !truthy(p.position)) continue;
      const quote = pyStrip(orStr(p.quote));
      found.push({
        ...p,
        transcript: tid,
        verbatim: Boolean(quote) && norm(transcripts.get(tid) ?? "").includes(norm(quote)),
      });
    }
    return found;
  };
  const [first, ...rest] = (await all<unknown>([
    findHanded(judge, transcripts, prompts["tensions-handed"] as string),
    ...tids.map(positionsFor),
  ])) as [Json[], ...Json[][]];
  const handed = first;
  const handedText = handedListing(handed);
  let foundByTid = new Map(tids.map((t, i) => [t, rest[i] as Json[]]));
  const foundTotal = [...foundByTid.values()].reduce((n, v) => n + v.length, 0);
  foundByTid = trimPositions(foundByTid);
  const positions: Json[] = [];
  for (const tid of tids)
    for (const p of foundByTid.get(tid) ?? [])
      positions.push({ id: `P${positions.length + 1}`, ...p });
  const byId = new Map(positions.map((p) => [String(p.id), p]));
  const [candidates, foundPairs] = await findCollisions(
    judge,
    positions,
    prompts.collisions as string,
    tids,
  );
  const verified = await verifyCandidates(
    judge,
    candidates,
    byId,
    prompts["tension-verify"] as string,
    transcripts,
    handedText,
  );
  const [valid, unsupported] = supported(verified);
  const kept = await dedupeTensions(judge, valid, o.maxTensions ?? MAX_TENSIONS);
  const tensions: Json[] = [];
  const gateFlags: string[] = [];
  const written = await writeTensions(judge, kept, byId, prompts["tension-write"] as string);
  written.forEach(([tension, flags], i) => {
    const item = kept[i] as Json;
    // Every quote arrives with the table that said it; the book only confirms.
    tension.quoteIds = book.addAll([...list(item.quotesA), ...list(item.quotesB)]);
    tensions.push(tension);
    gateFlags.push(...flags);
  });
  return {
    tensions: { tensions },
    gate_flags: gateFlags,
    counts: {
      handed: handed.length,
      handed_verified: handed.filter((h) => h.verified).length,
      positions: positions.length,
      candidates: candidates.length,
      found_pairs: foundPairs,
      found_positions: foundTotal,
      cross_table: candidates.filter((c) => c.cross_table).length,
      verified: valid.length,
      unsupported,
      kept: kept.length,
    },
  };
}
