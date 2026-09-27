import { dict, type Json, list, orStr, truthy } from "../py";
import { norm, pySplit, pyStrip } from "../text";
import { nameHits, scrubNames } from "./flags";
import { errText, pyRepr, settle, WB_END, WB_START } from "./util";

/**
 * The second pass over a conversation's phrases (popcorn enrichment.py): two calls per
 * phrase at once, evidence (the verbatim passage, checked by code) and kind (what the
 * speaker was doing, qualifiers, question form). A question written as a statement is
 * rewritten and validated again. Reasons and targets stay under `review`, names scrubbed.
 */

export const KINDS = [
  "observation",
  "distinction",
  "need",
  "practice",
  "idea",
  "objection",
  "question",
  "decision",
];
export const QUALIFIERS = ["tentative", "personal_experience", "not_implemented"];

export const VALIDATE_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["grounded", "quote", "reason"],
  properties: {
    grounded: { type: "boolean" },
    quote: { type: "string", maxLength: 400 },
    reason: { type: "string", maxLength: 300 },
  },
};
export const KIND_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "qualifiers", "question_form", "target", "reason"],
  properties: {
    kind: { type: "string", enum: KINDS },
    qualifiers: { type: "array", items: { type: "string", enum: QUALIFIERS } },
    question_form: { type: "boolean" },
    target: { type: "string", maxLength: 80 },
    reason: { type: "string", maxLength: 300 },
  },
};
export const QUESTION_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["phrase"],
  properties: { phrase: { type: "string", maxLength: 90 } },
};

const MIN_QUOTE_CHARS = 12;
const MAX_PHRASE_CHARS = 90;
const MAX_PHRASE_WORDS = 13;

// A modal the phrase carries that its source passage does not is a change of status.
const HEDGE = new RegExp(
  `${WB_START}(can|could|may|might|tends? to|often|sometimes|typically|usually|potentially)${WB_END}`,
  "giu",
);

const hedges = (s: string) =>
  new Set([...s.matchAll(HEDGE)].map((m) => (m[1] as string).toLowerCase()));

/** Hedges in the phrase that the source passage does not carry, sorted. */
export function hedgeAdded(phrase: string, quote: string): string[] {
  const inQuote = hedges(quote);
  return [...hedges(phrase)].filter((h) => !inQuote.has(h)).sort();
}

/** One validate answer: the quote counts only when it is verbatim. */
export function evidenceFrom(raw: Json, phrase: string, transcript: string): Json {
  const quote = pyStrip(orStr(raw.quote));
  const verbatim = [...quote].length >= MIN_QUOTE_CHARS && norm(transcript).includes(norm(quote));
  const grounded = truthy(raw.grounded) && verbatim;
  return {
    grounded,
    quote: grounded ? quote : "",
    hedge_added: grounded ? hedgeAdded(phrase, quote) : [],
    reason: pyStrip(orStr(raw.reason)),
    // the wording this evidence was checked against
    for: phrase,
  };
}

export class UnknownKind extends Error {}

/** One kind answer; anything that could reach a screen is scrubbed. */
export function kindFrom(raw: Json, names: ReadonlySet<string>): Json {
  const kind = orStr(raw.kind);
  if (!KINDS.includes(kind)) throw new UnknownKind(`unknown popcorn kind ${pyRepr(kind)}`);
  return {
    kind,
    qualifiers: list(raw.qualifiers).filter((q) => QUALIFIERS.includes(q as string)),
    question: truthy(raw.question_form),
    target: scrubNames(orStr(raw.target), names),
    reason: scrubNames(orStr(raw.reason), names),
  };
}

/** The rewrite has to pass the extractor's own contract, plus the mark. */
export function questionOk(phrase: string): boolean {
  return (
    phrase.endsWith("?") &&
    [...phrase].length <= MAX_PHRASE_CHARS &&
    pySplit(phrase).length <= MAX_PHRASE_WORDS &&
    !phrase.includes('"') &&
    !phrase.includes("\n")
  );
}

export type PhraseCall = (o: {
  transcriptId: string;
  transcript: string;
  phrase: string;
}) => Promise<Json>;

/** errText cut the way the Python cut it: str(exc)[:200]. */
const cut = (exc: unknown) => [...errText(exc)].slice(0, 200).join("");

/**
 * Both calls for one phrase at once, each failure kept on its own so the other still
 * lands. Returns a result record; nothing is applied here.
 */
export async function enrichItem(
  item: Json,
  o: {
    transcriptId: string;
    transcript: string;
    names: ReadonlySet<string>;
    validate: PhraseCall;
    classify: PhraseCall;
    rewrite: PhraseCall;
  },
): Promise<Json> {
  const phrase = orStr(item.phrase);
  const errors: string[] = [];
  const result: Json = { id: item.id ?? null, phrase, errors };
  const evidenceFor = async (text: string) =>
    evidenceFrom(
      await o.validate({ transcriptId: o.transcriptId, transcript: o.transcript, phrase: text }),
      text,
      o.transcript,
    );
  const kindFor = async (): Promise<[Json, string | null]> => {
    const raw = await o.classify({
      transcriptId: o.transcriptId,
      transcript: o.transcript,
      phrase,
    });
    const kind = kindFrom(raw, o.names);
    let rewritten: string | null = null;
    if (kind.kind === "question" && !kind.question) {
      try {
        const out = await o.rewrite({
          transcriptId: o.transcriptId,
          transcript: o.transcript,
          phrase,
        });
        const candidate = pyStrip(orStr(out.phrase));
        if (questionOk(candidate) && !nameHits(candidate, o.names).length) {
          rewritten = candidate.slice(0, -1).replace(/\s+$/u, "");
          kind.question = true;
        }
      } catch (exc) {
        errors.push(`question: ${cut(exc)}`);
      }
    }
    return [kind, rewritten];
  };
  let [evidence, kindOut] = await settle<unknown>([evidenceFor(phrase), kindFor()]);
  if (kindOut instanceof Error) errors.push(`kind: ${cut(kindOut)}`);
  else {
    const [kind, rewritten] = kindOut as [Json, string | null];
    result.kind = kind;
    if (rewritten) {
      result.rewritten = rewritten;
      // The words changed under the evidence: check the words the room reads.
      try {
        evidence = await evidenceFor(rewritten);
      } catch (exc) {
        evidence = exc instanceof Error ? exc : new Error(String(exc));
      }
    }
  }
  // One dead call must not cost the phrase its kind.
  if (evidence instanceof Error) errors.push(`evidence: ${cut(evidence)}`);
  else result.evidence = evidence;
  return result;
}

/**
 * Write the results onto the items, in place, once. `register(tid, text)` puts a
 * verified passage in the quote registry and returns its id.
 */
export function applyResults(
  items: Json[],
  results: readonly Json[],
  transcriptId: string,
  register: (tid: string, text: string) => string | null,
): { rooted: number; classified: number; rewritten: number } {
  const byId = new Map(results.map((r) => [String(r.id), r]));
  let rooted = 0;
  let classified = 0;
  let rewritten = 0;
  for (const item of items) {
    const r = byId.get(String(item.id));
    // The phrase changed under the pass; leave it for the next tick.
    if (r === undefined || r.phrase !== item.phrase) continue;
    const review: Json = { ...dict(item.review) };
    const evidence = r.evidence as Json | undefined;
    if (evidence !== undefined && evidence !== null) {
      if (evidence.grounded && evidence.quote) {
        const qid = register(transcriptId, String(evidence.quote));
        if (qid) {
          item.quoteId = qid;
          rooted++;
        } else delete item.quoteId;
      } else delete item.quoteId;
      // The pass answered: rooted or not. A failed call leaves this unset, to be retried.
      item.rooted = truthy(item.quoteId);
      review.evidence = evidence.reason;
      if (list(evidence.hedge_added).length) review.hedge_added = evidence.hedge_added;
    }
    const kind = r.kind as Json | undefined;
    if (kind !== undefined && kind !== null) {
      item.kind = kind.kind;
      item.question = kind.question;
      item.qualifiers = kind.qualifiers;
      review.kind = kind.reason;
      if (kind.target) review.target = kind.target;
      classified++;
      if (r.rewritten) {
        review.was = item.phrase;
        item.phrase = r.rewritten;
        rewritten++;
      }
    }
    if (list(r.errors).length) review.errors = [...list(r.errors)];
    else delete review.errors; // a retry that landed clears the old failure
    if (Object.keys(review).length) item.review = review;
  }
  return { rooted, classified, rewritten };
}
