import type { Json } from "../contracts";
import { pyRepr } from "../registry";
import { pySplit } from "../text";

/**
 * The popcorn stages the tensions recipe reuses (dembrane/popcorn/tensions.py and
 * gates.py): the judge that bounds and retries every call, the fair positions cap, the
 * handed stage, the dedupe stage and the screen gate. Ported here rather than shared with
 * the popcorn namespace because the recipe hashes their prompts and outputs into its step
 * keys: they must stay exactly the versions this recipe version was written against.
 */

/** One judgement that has not answered in this long is not going to. */
export const CALL_TIMEOUT_MS = 240_000;
export const MAX_TENSIONS = 8;
export const MAX_POSITIONS_TOTAL = 80;
export const MIN_ZERO_SUM = 0.2;
export const MAX_QUOTES_PER_TENSION = 4;

// Python's \w (Unicode letters, numbers, underscore) and \b around it; JavaScript's own
// \w and \b are ASCII-only, which would change what the gates flag in other languages.
export const W = "[\\p{L}\\p{N}_]";
export const WB_START = `(?<!${W})`;
export const WB_END = `(?!${W})`;

export const DEDUPE_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["same_as", "swapped", "why"],
  properties: {
    same_as: { type: "string", maxLength: 12 },
    swapped: { type: "boolean" },
    why: { type: "string", maxLength: 240 },
  },
};

export const WRITE_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["poleA", "poleB", "knot", "toResolve"],
  properties: {
    poleA: { type: "string", maxLength: 60 },
    poleB: { type: "string", maxLength: 60 },
    knot: { type: "string", maxLength: 140 },
    toResolve: { type: "string", maxLength: 170 },
  },
};

export const HANDED_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["handed"],
  properties: {
    handed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "quote", "transcript", "response", "status"],
        properties: {
          text: { type: "string", maxLength: 600 },
          quote: { type: "string", maxLength: 400 },
          transcript: { type: "string" },
          response: { type: "string", maxLength: 300 },
          status: {
            type: "string",
            enum: ["accepted", "argued", "called_false", "reversed", "dissolved", "ignored"],
          },
        },
      },
    },
  },
};

export const DEDUPE_SYSTEM = `You are given the tensions already kept from a session and one more verified
tension. Say whether the new one belongs to one already kept. It belongs when
it is the same pull between the same two things, however worded and whoever
held it; and also when it is a facet of a kept tension: it shares one pole
with it and its other pole is a middle course between the kept poles, a
reason behind one of them, or a consequence of one of them (the kept tension's
knot will carry the facet). Return \`same_as\` with the id of the kept tension
it belongs to, or an empty string when it pulls between two things no kept
tension pulls between, and a \`why\` of one line. \`swapped\` is true when the new
tension's A side belongs with the kept tension's B side (and its B with the
kept A), false when the sides line up, and false when \`same_as\` is empty.
Two tensions on the same subject that pull between different things are not
the same; two tensions that share a pole and pull on the same thing from two
angles are.`;

export type Generate = (o: {
  systemPrompt: string;
  userText: string;
  schema: Json;
  thinking: boolean;
}) => Promise<Json>;

/** Python's re.sub(r"\s+", " ", text).strip().casefold(), popcorn's quote key. */
export const popcornNorm = (text: string) =>
  pySplit(text).join(" ").toUpperCase().toLowerCase().replaceAll("ς", "σ");

export function corpus(
  transcripts: Readonly<Record<string, string>>,
  tids: readonly string[],
): string {
  return tids
    .map((t) => `TRANSCRIPT id: ${t}\n${transcripts[t]}\nEND TRANSCRIPT ${t}`)
    .join("\n\n");
}

/** The first transcript in `order` holding the quote word for word, or null. */
export function locate(
  quote: string,
  transcripts: Readonly<Record<string, string>>,
  order: readonly string[],
): string | null {
  const key = popcornNorm(quote);
  if (!key) return null;
  for (const tid of order)
    if (tid in transcripts && popcornNorm(transcripts[tid] as string).includes(key)) return tid;
  return null;
}

/** The tables a position was held at, its own first. */
export function tablesOf(position: Json): string[] {
  const tables = position.tables as string[] | undefined;
  return tables?.length ? [...tables] : [String(position.transcript)];
}

/**
 * At most `cap` positions across the transcripts: each transcript's firmest first, the
 * transcripts taking turns, every transcript with a position keeping at least one.
 */
export function trimPositions(
  found: Map<string, Json[]>,
  capIn = MAX_POSITIONS_TOTAL,
): Map<string, Json[]> {
  let total = 0;
  let nonEmpty = 0;
  for (const v of found.values()) {
    total += v.length;
    if (v.length) nonEmpty++;
  }
  const cap = Math.max(capIn, nonEmpty);
  if (total <= cap || !found.size) return found;
  const ranked = new Map<string, number[]>();
  for (const [tid, items] of found)
    ranked.set(
      tid,
      items
        .map((_, i) => i)
        .sort((a, b) => {
          const ka = [items[a]?.verbatim ? 0 : 1, items[a]?.hedged ? 1 : 0, a];
          const kb = [items[b]?.verbatim ? 0 : 1, items[b]?.hedged ? 1 : 0, b];
          return (
            (ka[0] as number) - (kb[0] as number) || (ka[1] as number) - (kb[1] as number) || a - b
          );
        }),
    );
  const keep = new Map<string, Set<number>>([...found.keys()].map((t) => [t, new Set()]));
  let taken = 0;
  let round = 0;
  while (taken < cap && [...ranked.values()].some((r) => round < r.length)) {
    for (const [tid, order] of ranked) {
      if (taken >= cap) break;
      if (round < order.length) {
        keep.get(tid)?.add(order[round] as number);
        taken++;
      }
    }
    round++;
  }
  return new Map(
    [...found.entries()].map(([tid, items]) => [
      tid,
      items.filter((_, i) => keep.get(tid)?.has(i)),
    ]),
  );
}

export class JudgeFailed extends Error {}

/** The model, one bounded judgement at a time per slot, counted in one place and tried twice. */
export class Judge {
  calls = 0;
  retries = 0;
  readonly byLabel: Record<string, number> = {};
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly generate: Generate,
    private readonly concurrency = 8,
    private readonly retryable: (err: unknown) => boolean = () => false,
  ) {}

  stage(_name: string, _counts: Json = {}): void {}

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /**
   * A call that times out or answers in broken JSON is asked once more; a second failure
   * names the stage, so the run's outcome says which stage died.
   */
  call(
    system: string,
    user: string,
    schema: Json,
    o: { thinking?: boolean; label?: string } = {},
  ): Promise<Json> {
    const label = o.label ?? "model";
    return this.slot(async () => {
      for (const attempt of [1, 2]) {
        this.calls++;
        this.byLabel[label] = (this.byLabel[label] ?? 0) + 1;
        try {
          return await withTimeout(
            this.generate({
              systemPrompt: system,
              userText: user,
              schema,
              thinking: o.thinking ?? true,
            }),
            CALL_TIMEOUT_MS,
          );
        } catch (err) {
          const timeout = (err as Error)?.name === "TimeoutError";
          if (!timeout && !this.retryable(err)) throw err;
          if (attempt === 1) {
            this.retries++;
            continue;
          }
          if (timeout)
            throw new JudgeFailed(
              `${label} call took more than ${CALL_TIMEOUT_MS / 1000} s, twice`,
            );
          throw new JudgeFailed(`${label} call answered badly twice: ${(err as Error).message}`);
        }
      }
      throw new Error("unreachable");
    });
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the rooms were handed, over the whole corpus; an unfound quote is marked unverified. */
export async function findHanded(
  judge: Judge,
  transcripts: Record<string, string>,
  prompt: string,
): Promise<Json[]> {
  const tids = Object.keys(transcripts);
  const out = await judge.call(prompt, corpus(transcripts, tids), HANDED_SCHEMA, {
    label: "handed",
  });
  const items: Json[] = [];
  for (const h of (out.handed as unknown[]) ?? []) {
    if (!h || typeof h !== "object" || Array.isArray(h)) continue;
    const item = h as Json;
    const quote = String(item.quote || "").trim();
    const claimed = String(item.transcript || "");
    const where = quote ? locate(quote, transcripts, [claimed, ...tids]) : null;
    items.push({ ...item, transcript: where || claimed, verified: where !== null });
  }
  return items;
}

/** The handed list as the verifier reads it. */
export function handedListing(handed: readonly Json[]): string {
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

/** str(value) the way an f-string prints a value from a model answer. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

function support(v: Json, position: string, via: string, extra: Json = {}): Json {
  return { position, pair: [v.a, v.b], via, verify_why: v.verify_why, ...extra };
}

/**
 * Dedupe in rank order, one call per pair against what is kept. Every kept tension carries
 * the positions holding each pole, its own pair first, growing with every facet folded in.
 */
export async function dedupeTensions(
  judge: Judge,
  valid: readonly Json[],
  maxTensions = MAX_TENSIONS,
): Promise<Json[]> {
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
      { thinking: false, label: "dedupe" },
    );
    const same = String(out.same_as || "").trim();
    const target = same ? kept.find((k) => k.id === same) : undefined;
    if (target) {
      const swapped = Boolean(out.swapped);
      const why = String(out.why || "");
      const merged = (target.merged as Json[] | undefined) ?? [];
      merged.push({ a: v.a, b: v.b, why, swapped });
      target.merged = merged;
      for (const [side, into] of [
        ["quotesA", swapped ? "quotesB" : "quotesA"],
        ["quotesB", swapped ? "quotesA" : "quotesB"],
      ] as const) {
        for (const q of (v[side] as Json[]) ?? []) {
          const held = [...(target.quotesA as Json[]), ...(target.quotesB as Json[])].map(
            (x) => x.text,
          );
          if (!held.includes(q.text) && held.length < MAX_QUOTES_PER_TENSION)
            (target[into] as Json[]).push(q);
        }
      }
      for (const [pid, into] of [
        [String(v.a), swapped ? "supportB" : "supportA"],
        [String(v.b), swapped ? "supportA" : "supportB"],
      ] as const) {
        const other = into === "supportB" ? "supportA" : "supportB";
        if ((target[into] as Json[]).some((s) => s.position === pid)) continue;
        if ((target[other] as Json[]).some((s) => s.position === pid)) {
          const both = (target.both_poles as string[] | undefined) ?? [];
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

// ── the screen gate (popcorn gates.screen_flags) ────────────────────────

export const POLE_WORDS = 7;
export const KNOT_WORDS = 18;
export const QUESTION_WORDS = 22;
export const POLE_MIN_WORDS = 3;
const SENTENCE_END = /[.!?](\s|$)/gu;
const MEETING = new RegExp(
  `${WB_START}(participants?|attendees|the (group|room|team) (discussed|recognised|recognized|acknowledged` +
    `|expressed|felt|noted)|discussed|recognis${W}+|recogniz${W}+|acknowledg${W}+` +
    `|express${W}+ (concern|a desire|the need)|feel(s|ing)? that|felt that)${WB_END}`,
  "iu",
);

const words = (s: unknown) => pySplit(String(s ?? "")).length;
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** Every line of a tension lands in one glance from the back of the room. */
export function screenFlags(tensions: readonly Json[]): string[] {
  const flags: string[] = [];
  for (const t of tensions) {
    const tid = t.id ?? "?";
    for (const pole of ["poleA", "poleB"]) {
      const n = words(t[pole]);
      if (n > POLE_WORDS)
        flags.push(`${tid} ${pole}: ${n} words, at most ${POLE_WORDS}: ${pyRepr(t[pole])}`);
      else if (n < POLE_MIN_WORDS)
        flags.push(`${tid} ${pole}: ${n} words, at least ${POLE_MIN_WORDS}: ${pyRepr(t[pole])}`);
    }
    const knot = text(t.knot);
    if (!knot) flags.push(`${tid} knot: missing`);
    else if (words(knot) > KNOT_WORDS)
      flags.push(`${tid} knot: ${words(knot)} words, at most ${KNOT_WORDS}: ${pyRepr(knot)}`);
    else if ((knot.trim().match(SENTENCE_END) ?? []).length > 1)
      flags.push(`${tid} knot: more than one sentence: ${pyRepr(knot)}`);
    if (!text(t.toResolve).trim()) flags.push(`${tid} toResolve: missing`);
    else if (words(t.toResolve) > QUESTION_WORDS)
      flags.push(
        `${tid} toResolve: ${words(t.toResolve)} words, at most ${QUESTION_WORDS}: ${pyRepr(t.toResolve)}`,
      );
    for (const field of ["knot", "toResolve"]) {
      const m = MEETING.exec(text(t[field]));
      if (m)
        flags.push(`${tid} ${field}: reports the meeting (${pyRepr(m[0])}): ${pyRepr(t[field])}`);
    }
  }
  return flags;
}
