import type { Json } from "../contracts";
import { PyFloat, sha256Hex } from "../hashing";
import { compareStrings, sortedStrings } from "../registry";
import { casefold, normalizeText, normKey } from "../text";
import { dataBlock } from "./model";

/**
 * Deduplicated arguments, the pure core: embedding similarity proposes candidate groups,
 * one model answer per group proposes sub-groups, and code alone decides what merges (an
 * equivalent sub-group of one kind and valence, a statement, and an equivalent judgement
 * for every member, in an answer that accounts for every member once). False merges are
 * worse than missed duplicates. Documents keep the Python dataclasses' snake_case field
 * names because they are stored as step artifacts and hashed into later cache keys.
 */

export const RECIPE_ID = "deduplicated_arguments";
export const RECIPE_VERSION = "dedup-v2";
export const CANDIDATE_STRATEGY = "emb-complete-linkage-v1";
export const CANDIDATE_STRATEGY_VERSION = 1;
export const VERIFY_PROMPT = "dedup-verify-v2";

export const EPISTEMIC_KINDS = ["argument", "claim"];
export const VALENCES = ["positive", "negative", "neutral"];
export const VERDICTS = ["equivalent", "not_equivalent", "uncertain"];

/** Calibrated candidate thresholds per embedding model; an unknown model finds identical statements only. */
export const CANDIDATE_SIMILARITY_BY_MODEL: Record<string, number> = {
  "text-embedding-004": 0.8,
  "gemini-embedding-001": 0.92,
};

export const DEFAULT_MAX_GROUP_SIZE = 8;
export const DEFAULT_MAX_CANDIDATE_GROUPS = 250;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_QUOTES_SHOWN = 3;
export const MAX_QUOTE_CHARS = 500;

export class InvalidInput extends Error {}
export class MalformedAnswer extends Error {}
export class AccountingError extends Error {}

export interface Evidence {
  readonly conversation_id: string;
  readonly quote: string;
  readonly location: string | null;
}

export interface SourceArgument {
  readonly revision_id: string;
  readonly object_id: string;
  readonly statement: string;
  readonly epistemic_kind: string;
  readonly valence: string;
  readonly evidence: readonly Evidence[];
  readonly embedding: readonly number[];
  readonly embedding_config_key: string;
}

export interface DeduplicationParams {
  readonly embeddingModel: string;
  readonly similarityThreshold: number | null;
  readonly maxGroupSize: number;
  readonly maxCandidateGroups: number;
  readonly concurrency: number;
}

export function checkParams(p: DeduplicationParams): void {
  if (p.similarityThreshold !== null && !(p.similarityThreshold > 0 && p.similarityThreshold <= 1))
    throw new InvalidInput("similarity_threshold must be in (0, 1]");
  if (p.maxGroupSize < 2) throw new InvalidInput("max_group_size must be at least 2");
  if (p.maxCandidateGroups < 0) throw new InvalidInput("max_candidate_groups must not be negative");
  if (p.concurrency < 1) throw new InvalidInput("concurrency must be at least 1");
}

/** The threshold and its source: override, calibrated or uncalibrated (identical statements only). */
export function candidateThreshold(p: DeduplicationParams): [number | null, string] {
  if (p.similarityThreshold !== null) return [p.similarityThreshold, "override"];
  const name = p.embeddingModel.split("/").at(-1) ?? "";
  const threshold = CANDIDATE_SIMILARITY_BY_MODEL[name] ?? null;
  return [threshold, threshold !== null ? "calibrated" : "uncalibrated"];
}

export function validateArguments(args: readonly SourceArgument[]): void {
  const seen = new Set<string>();
  let configKey: string | null = null;
  let dims: number | null = null;
  for (const a of args) {
    const revision = a.revision_id;
    if (typeof revision !== "string" || !revision)
      throw new InvalidInput("an argument has no revision id");
    if (seen.has(revision)) throw new InvalidInput(`revision ${revision} appears more than once`);
    seen.add(revision);
    if (!a.object_id) throw new InvalidInput(`revision ${revision} has no object id`);
    if (!normalizeText(a.statement))
      throw new InvalidInput(`revision ${revision} has an empty statement`);
    if (!EPISTEMIC_KINDS.includes(a.epistemic_kind))
      throw new InvalidInput(`revision ${revision} has an unknown epistemic kind`);
    if (!VALENCES.includes(a.valence))
      throw new InvalidInput(`revision ${revision} has an unknown valence`);
    if (!a.embedding_config_key)
      throw new InvalidInput(`revision ${revision} has no embedding configuration`);
    if (configKey === null) configKey = a.embedding_config_key;
    else if (a.embedding_config_key !== configKey)
      throw new InvalidInput("arguments must share one embedding configuration");
    const vector = a.embedding;
    if (!Array.isArray(vector) || !vector.length)
      throw new InvalidInput(`revision ${revision} has no embedding`);
    if (dims === null) dims = vector.length;
    else if (vector.length !== dims)
      throw new InvalidInput(
        `revision ${revision} has ${vector.length} dimensions, expected ${dims}`,
      );
    for (const v of vector) {
      if (typeof v !== "number")
        throw new InvalidInput(`revision ${revision} has a non-numeric embedding value`);
      if (!Number.isFinite(v))
        throw new InvalidInput(`revision ${revision} has a non-finite embedding value`);
    }
    if (!vector.some((v) => v !== 0))
      throw new InvalidInput(`revision ${revision} has the zero vector`);
  }
}

// ── candidate discovery ─────────────────────────────────────────────────

export interface CandidateGroup {
  readonly group_id: string;
  readonly epistemic_kind: string;
  readonly valence: string;
  readonly units: readonly (readonly string[])[];
  /** Rounded to six digits; a float on the Python side, so it hashes as one. */
  readonly min_similarity: PyFloat;
}

export const groupRevisionIds = (g: CandidateGroup) => g.units.flat();

export interface Discovery {
  readonly units: readonly (readonly string[])[];
  readonly groups: readonly CandidateGroup[];
  readonly skipped: readonly CandidateGroup[];
  /** Python's Coverage dataclass, field for field. */
  readonly coverage: Json;
}

export const groupIdFor = (revisionIds: Iterable<string>) =>
  `cg-${sha256Hex(sortedStrings(revisionIds).join("\x1f")).slice(0, 16)}`;

/** round(value, 6) as Python rounds a float (exact decimal rounding of the binary value). */
const round6 = (v: number) => Number(v.toFixed(6));

/**
 * Cosine similarity of row-normalised vectors, as numpy computed it (norm, divide, dot).
 * Floating point order can differ from BLAS in the last bit; that only matters for a
 * similarity within about 1e-15 of the threshold or of a six-digit rounding boundary.
 */
function similarityMatrix(vectors: readonly (readonly number[])[]): number[][] {
  const unit = vectors.map((v) => {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  });
  return unit.map((a) => unit.map((b) => a.reduce((s, x, i) => s + x * (b[i] as number), 0)));
}

/** Clusters in which every pair reaches the threshold, joined from the most similar pair down. */
function completeLinkage(sim: number[][], threshold: number): number[][] {
  const n = sim.length;
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const owner = Array.from({ length: n }, (_, i) => i);
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if ((sim[i]?.[j] ?? 0) >= threshold) pairs.push([i, j]);
  pairs.sort(([a, b], [c, d]) => (sim[c]?.[d] ?? 0) - (sim[a]?.[b] ?? 0) || a - c || b - d);
  for (const [i, j] of pairs) {
    const gi = owner[i] as number;
    const gj = owner[j] as number;
    if (gi === gj) continue;
    const all = (members[gi] as number[]).every((x) =>
      (members[gj] as number[]).every((y) => (sim[x]?.[y] ?? 0) >= threshold),
    );
    if (!all) continue;
    const [keep, gone] = gi < gj ? [gi, gj] : [gj, gi];
    for (const m of members[gone] as number[]) owner[m] = keep;
    (members[keep] as number[]).push(...(members[gone] as number[]));
    members[gone] = [];
  }
  return members.filter((m) => m.length).map((m) => [...m].sort((a, b) => a - b));
}

/** Chunks of at most `maxSize`, grown by the member whose lowest similarity to the chunk is highest. */
function splitCluster(cluster: number[], sim: number[][], maxSize: number): number[][] {
  if (cluster.length <= maxSize) return [[...cluster].sort((a, b) => a - b)];
  const remaining = [...cluster].sort((a, b) => a - b);
  const chunks: number[][] = [];
  while (remaining.length) {
    const chunk = [remaining.shift() as number];
    while (remaining.length && chunk.length < maxSize) {
      let best = remaining[0] as number;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const j of remaining) {
        const score = Math.min(...chunk.map((k) => sim[j]?.[k] ?? 0));
        // Python's max keeps the first maximum of (score, -j): higher score, then smaller j.
        if (score > bestScore || (score === bestScore && j < best)) {
          best = j;
          bestScore = score;
        }
      }
      chunk.push(best);
      remaining.splice(remaining.indexOf(best), 1);
    }
    chunks.push(chunk.sort((a, b) => a - b));
  }
  return chunks;
}

/** Exact units and candidate groups, without any model call. */
export function discoverCandidates(
  args: readonly SourceArgument[],
  params: DeduplicationParams,
): Discovery {
  checkParams(params);
  validateArguments(args);
  const [threshold, thresholdSource] = candidateThreshold(params);

  const byKey = new Map<string, number[]>();
  args.forEach((a, index) => {
    const key = JSON.stringify([a.epistemic_kind, a.valence, normKey(a.statement)]);
    const list = byKey.get(key) ?? [];
    list.push(index);
    byKey.set(key, list);
  });
  const unitIndices = [...byKey.values()].sort((a, b) => (a[0] as number) - (b[0] as number));
  const units = unitIndices.map((u) => u.map((i) => (args[i] as SourceArgument).revision_id));

  const partitions = new Map<string, number[]>();
  unitIndices.forEach((unit, position) => {
    const head = args[unit[0] as number] as SourceArgument;
    const key = `${head.epistemic_kind}\x1f${head.valence}`;
    const list = partitions.get(key) ?? [];
    list.push(position);
    partitions.set(key, list);
  });

  const found: [number, CandidateGroup][] = [];
  let clustersFound = 0;
  let clustersSplit = 0;
  if (threshold !== null) {
    const keys = [...partitions.keys()].sort((a, b) => compareStrings(a, b));
    for (const key of keys) {
      const [kind, valence] = key.split("\x1f") as [string, string];
      const positions = partitions.get(key) as number[];
      if (positions.length < 2) continue;
      const sim = similarityMatrix(
        positions.map(
          (p) => (args[(unitIndices[p] as number[])[0] as number] as SourceArgument).embedding,
        ),
      );
      for (const cluster of completeLinkage(sim, threshold)) {
        if (cluster.length < 2) continue;
        clustersFound++;
        const chunks = splitCluster(cluster, sim, params.maxGroupSize);
        if (chunks.length > 1) clustersSplit++;
        for (const chunk of chunks) {
          if (chunk.length < 2) continue;
          let lowest = Number.POSITIVE_INFINITY;
          for (const a of chunk)
            for (const b of chunk) if (a < b) lowest = Math.min(lowest, sim[a]?.[b] ?? 0);
          const groupUnits = chunk.map((local) => units[positions[local] as number] as string[]);
          found.push([
            (unitIndices[positions[chunk[0] as number] as number] as number[])[0] as number,
            {
              group_id: groupIdFor(groupUnits.flat()),
              epistemic_kind: kind,
              valence,
              units: groupUnits,
              min_similarity: new PyFloat(round6(lowest)),
            },
          ]);
        }
      }
    }
  }
  // The likeliest duplicates are verified first when the group limit binds.
  found.sort(([ia, a], [ib, b]) => b.min_similarity.value - a.min_similarity.value || ia - ib);
  const ordered = found.map(([, g]) => g);
  const considered = ordered.slice(0, params.maxCandidateGroups);
  const skipped = ordered.slice(params.maxCandidateGroups);

  const exact = units.filter((u) => u.length > 1);
  const exactMembers = new Set(exact.flat());
  const consideredMembers = new Set(considered.flatMap(groupRevisionIds));
  const skippedMembers = new Set(skipped.flatMap(groupRevisionIds));
  const reasons: string[] = [];
  if (clustersSplit) reasons.push("max_group_size");
  if (skipped.length) reasons.push("max_candidate_groups");
  const coverage: Json = {
    strategy: CANDIDATE_STRATEGY,
    strategy_version: CANDIDATE_STRATEGY_VERSION,
    embedding_model: params.embeddingModel,
    embedding_config_key: args[0]?.embedding_config_key ?? null,
    threshold: threshold === null ? null : new PyFloat(threshold),
    threshold_source: thresholdSource,
    semantic_discovery: threshold !== null,
    max_group_size: params.maxGroupSize,
    max_candidate_groups: params.maxCandidateGroups,
    inputs: args.length,
    exact_match_groups: exact.length,
    exact_match_members: exactMembers.size,
    clusters_found: clustersFound,
    clusters_split: clustersSplit,
    groups_found: ordered.length,
    groups_considered: considered.length,
    groups_skipped: skipped.length,
    members_covered: new Set([...consideredMembers, ...exactMembers]).size,
    members_skipped: [...skippedMembers].filter((r) => !exactMembers.has(r)).length,
    truncated: reasons.length > 0,
    truncation_reasons: reasons,
  };
  return { units, groups: considered, skipped, coverage };
}

export const discoveryDoc = (d: Discovery): Json => ({
  units: d.units.map((u) => [...u]),
  groups: d.groups.map((g) => ({ ...g, units: g.units.map((u) => [...u]) })),
  skipped: d.skipped.map((g) => ({ ...g, units: g.units.map((u) => [...u]) })),
  coverage: d.coverage,
});

// ── verification ────────────────────────────────────────────────────────

export interface VerificationMember {
  readonly label: string;
  readonly revision_ids: readonly string[];
  readonly epistemic_kind: string;
  readonly valence: string;
  readonly statement: string;
  readonly quotes: readonly string[];
}

/** What one verification call reads; members carry labels (m1, m2...), never database ids. */
export interface VerificationRequest {
  readonly group_id: string;
  readonly members: readonly VerificationMember[];
}

function revisionIdsFor(request: VerificationRequest, label: string): readonly string[] {
  const member = request.members.find((m) => m.label === label);
  if (!member) throw new Error(label);
  return member.revision_ids;
}

const codePoints = (s: string, n: number) => [...s].slice(0, n).join("");

export function buildRequest(
  group: CandidateGroup,
  byRevision: ReadonlyMap<string, SourceArgument>,
): VerificationRequest {
  return {
    group_id: group.group_id,
    members: group.units.map((unit, i) => {
      const head = byRevision.get(unit[0] as string) as SourceArgument;
      const quotes: string[] = [];
      const known = new Set<string>();
      for (const revision of unit)
        for (const item of (byRevision.get(revision) as SourceArgument).evidence) {
          const quote = codePoints(normalizeText(item.quote), MAX_QUOTE_CHARS);
          if (quote && !known.has(casefold(quote)) && quotes.length < MAX_QUOTES_SHOWN) {
            known.add(casefold(quote));
            quotes.push(quote);
          }
        }
      return {
        label: `m${i + 1}`,
        revision_ids: [...unit],
        epistemic_kind: head.epistemic_kind,
        valence: head.valence,
        statement: normalizeText(head.statement),
        quotes,
      };
    }),
  };
}

/** The user message: every statement and quote on one line, only inside the ARGUMENTS block. */
export function verificationUserText(request: VerificationRequest): string {
  const lines: string[] = [];
  for (const m of request.members) {
    lines.push(
      m.label,
      `kind: ${m.epistemic_kind}`,
      `valence: ${m.valence}`,
      `statement: ${m.statement}`,
      "quotes:",
    );
    for (const quote of m.quotes) lines.push(`- "${quote}"`);
    lines.push("");
  }
  const labels = request.members.map((m) => m.label).join(", ");
  return [
    `A candidate group of ${request.members.length} members: ${labels}.`,
    dataBlock("ARGUMENTS", lines.join("\n").trim()),
    "Split the members into sub-groups, account for every member exactly once, and check each proposed statement against every member of its sub-group.",
  ].join("\n\n");
}

export interface MemberCheck {
  readonly label: string;
  readonly revision_ids: readonly string[];
  readonly judgement: string;
  readonly note: string;
}

export interface SubGroupOutcome {
  readonly labels: readonly string[];
  readonly revision_ids: readonly string[];
  readonly verdict: string;
  readonly proposed_statement: string;
  readonly rationale: string;
  readonly checks: readonly MemberCheck[];
  readonly merged: boolean;
  readonly outcome: string;
}

export interface GroupCheck {
  readonly group_id: string;
  readonly revision_ids: readonly string[];
  readonly min_similarity: PyFloat | number;
  /** verified, malformed or call_failed; the last two keep every member separate. */
  readonly status: string;
  readonly error: string | null;
  readonly sub_groups: readonly SubGroupOutcome[];
  readonly usage: Readonly<Record<string, number>>;
}

interface RawSubGroup {
  labels: string[];
  statement: string;
  verdict: string;
  rationale: string;
  checks: [string, string, string][];
}

/** Python's repr of a value named in an error text. */
function repr(v: unknown): string {
  if (typeof v === "string") return `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const isDict = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function parseAnswer(raw: unknown, labels: readonly string[]): RawSubGroup[] {
  if (!isDict(raw)) throw new MalformedAnswer("the answer is not a JSON object");
  const groups = raw.groups;
  if (!Array.isArray(groups) || !groups.length)
    throw new MalformedAnswer("the answer has no groups");
  const known = new Set(labels);
  const seen = new Set<string>();
  const parsed: RawSubGroup[] = [];
  groups.forEach((value, position) => {
    const where = `sub-group ${position + 1}`;
    if (!isDict(value)) throw new MalformedAnswer(`${where} is not an object`);
    const members = value.members;
    if (!Array.isArray(members) || !members.length)
      throw new MalformedAnswer(`${where} has no members`);
    for (const label of members) {
      if (typeof label !== "string" || !known.has(label))
        throw new MalformedAnswer(`${where} names an unknown member ${repr(label)}`);
      if (seen.has(label)) throw new MalformedAnswer(`member ${label} appears more than once`);
      seen.add(label);
    }
    const { proposed_statement: statement, verdict, rationale, checks } = value;
    if (typeof statement !== "string")
      throw new MalformedAnswer(`${where} has no proposed statement`);
    if (!VERDICTS.includes(verdict as string))
      throw new MalformedAnswer(`${where} has an unknown verdict ${repr(verdict)}`);
    if (typeof rationale !== "string") throw new MalformedAnswer(`${where} has no rationale`);
    if (!Array.isArray(checks)) throw new MalformedAnswer(`${where} has no checks`);
    const shaped: [string, string, string][] = [];
    for (const check of checks) {
      if (
        !isDict(check) ||
        typeof check.member !== "string" ||
        !VERDICTS.includes(check.judgement as string) ||
        typeof check.note !== "string"
      )
        throw new MalformedAnswer(`${where} has a malformed check`);
      shaped.push([check.member, check.judgement as string, check.note]);
    }
    parsed.push({
      labels: members as string[],
      statement,
      verdict: String(verdict),
      rationale,
      checks: shaped,
    });
  });
  const missing = labels.filter((l) => !seen.has(l));
  if (missing.length) throw new MalformedAnswer(`members not accounted for: ${missing.join(", ")}`);
  return parsed;
}

function judge(
  sub: RawSubGroup,
  request: VerificationRequest,
  byRevision: ReadonlyMap<string, SourceArgument>,
): SubGroupOutcome {
  const labels = new Set(sub.labels);
  const revisionIds = sub.labels.flatMap((l) => [...revisionIdsFor(request, l)]);
  const checks: MemberCheck[] = sub.checks.map(([label, judgement, note]) => ({
    label,
    revision_ids: labels.has(label) ? [...revisionIdsFor(request, label)] : [],
    judgement,
    note: normalizeText(note),
  }));
  const checked = checks.map((c) => c.label);
  const attributes = new Set(
    revisionIds.map((r) => {
      const a = byRevision.get(r) as SourceArgument;
      return `${a.epistemic_kind}\x1f${a.valence}`;
    }),
  );
  const checkedSet = new Set(checked);
  let outcome: string;
  if (sub.labels.length < 2) outcome = "single_member";
  else if (attributes.size > 1) outcome = "mixed_attributes";
  else if (sub.verdict !== "equivalent") outcome = sub.verdict;
  else if (!normalizeText(sub.statement)) outcome = "empty_statement";
  else if (
    checked.length !== checkedSet.size ||
    checkedSet.size !== labels.size ||
    [...labels].some((l) => !checkedSet.has(l))
  )
    outcome = "checks_incomplete";
  else if (checks.some((c) => c.judgement !== "equivalent")) outcome = "member_not_equivalent";
  else outcome = "merged";
  return {
    labels: [...sub.labels],
    revision_ids: revisionIds,
    verdict: sub.verdict,
    proposed_statement: normalizeText(sub.statement),
    rationale: normalizeText(sub.rationale),
    checks,
    merged: outcome === "merged",
    outcome,
  };
}

/** Applies the merge rules to one verifier answer. */
export function checkAnswer(
  group: CandidateGroup,
  request: VerificationRequest,
  byRevision: ReadonlyMap<string, SourceArgument>,
  raw: unknown,
  usage: Readonly<Record<string, number>> = {},
): GroupCheck {
  const labels = request.members.map((m) => m.label);
  const base = {
    group_id: group.group_id,
    revision_ids: groupRevisionIds(group),
    min_similarity: group.min_similarity,
  };
  let subs: RawSubGroup[];
  try {
    subs = parseAnswer(raw, labels);
  } catch (err) {
    if (!(err instanceof MalformedAnswer)) throw err;
    return {
      ...base,
      status: "malformed",
      error: err.message,
      sub_groups: [],
      usage: { ...usage },
    };
  }
  return {
    ...base,
    status: "verified",
    error: null,
    sub_groups: subs.map((s) => judge(s, request, byRevision)),
    usage: { ...usage },
  };
}

export function callFailed(group: CandidateGroup, error: string): GroupCheck {
  return {
    group_id: group.group_id,
    revision_ids: groupRevisionIds(group),
    min_similarity: group.min_similarity,
    status: "call_failed",
    error,
    sub_groups: [],
    usage: {},
  };
}

// ── output ──────────────────────────────────────────────────────────────

export interface Verification {
  /** model, exact_match or none. */
  readonly method: string;
  readonly outcome: string;
  readonly verdict: string | null;
  readonly rationale: string;
  readonly group_id: string | null;
  readonly checks: readonly MemberCheck[];
}

export interface DeduplicatedItem {
  readonly statement: string;
  readonly epistemic_kind: string;
  readonly valence: string;
  readonly member_revision_ids: readonly string[];
  readonly member_object_ids: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly support_count: number;
  readonly statement_revision_id: string | null;
  readonly verification: Verification;
}

export interface DeduplicationResult {
  readonly recipe_id: string;
  readonly recipe_version: string;
  readonly prompt_id: string;
  readonly consolidated: readonly DeduplicatedItem[];
  readonly singletons: readonly DeduplicatedItem[];
  readonly checks: readonly GroupCheck[];
  readonly coverage: Json;
  readonly usage: Readonly<Record<string, number>>;
}

export const resultItems = (r: DeduplicationResult) => [...r.consolidated, ...r.singletons];

function makeItem(
  revisions: readonly string[],
  byRevision: ReadonlyMap<string, SourceArgument>,
  statement: string,
  verification: Verification,
): DeduplicatedItem {
  const members = revisions.map((r) => byRevision.get(r) as SourceArgument);
  const evidence: Evidence[] = [];
  const known = new Set<string>();
  for (const m of members)
    for (const e of m.evidence) {
      const key = `${e.conversation_id}\x1f${normKey(e.quote)}`;
      if (!known.has(key)) {
        known.add(key);
        evidence.push(e);
      }
    }
  const sameText =
    members.find((m) => normKey(m.statement) === normKey(statement))?.revision_id ?? null;
  const first = members[0] as SourceArgument;
  return {
    statement,
    epistemic_kind: first.epistemic_kind,
    valence: first.valence,
    member_revision_ids: [...revisions],
    member_object_ids: members.map((m) => m.object_id),
    evidence,
    support_count: members.length,
    statement_revision_id: sameText,
    verification,
  };
}

/** Raises unless every input revision is in exactly one item and no item holds anything else. */
export function accountFor(
  args: readonly SourceArgument[],
  items: readonly DeduplicatedItem[],
): void {
  const expected = args.map((a) => a.revision_id);
  const produced = items.flatMap((i) => [...i.member_revision_ids]);
  if (sortedStrings(produced).join("\x1f") !== sortedStrings(expected).join("\x1f")) {
    const missing = sortedStrings(new Set(expected.filter((r) => !produced.includes(r))));
    const extra = sortedStrings(new Set(produced.filter((r) => !expected.includes(r))));
    const repeated = sortedStrings(new Set(produced.filter((r, i) => produced.indexOf(r) !== i)));
    const list = (xs: string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;
    throw new AccountingError(
      `output does not account for its inputs: missing ${list(missing)}, unknown ${list(extra)}, repeated ${list(repeated)}`,
    );
  }
}

/** Merged sub-groups, exact units and pass-through singletons, every input in exactly one. */
export function assembleResult(
  args: readonly SourceArgument[],
  discovery: Discovery,
  checks: readonly GroupCheck[],
): DeduplicationResult {
  const byRevision = new Map(args.map((a) => [a.revision_id, a]));
  const position = new Map(args.map((a, i) => [a.revision_id, i]));
  const pos = (r: string) => position.get(r) as number;
  const context = new Map<string, [GroupCheck, SubGroupOutcome | null]>();
  const consolidated: DeduplicatedItem[] = [];
  const claimed = new Set<string>();
  for (const check of checks) {
    for (const r of check.revision_ids) context.set(r, [check, null]);
    for (const sub of check.sub_groups) {
      for (const r of sub.revision_ids) context.set(r, [check, sub]);
      if (!sub.merged) continue;
      const revisions = [...sub.revision_ids].sort((a, b) => pos(a) - pos(b));
      for (const r of revisions) claimed.add(r);
      consolidated.push(
        makeItem(revisions, byRevision, sub.proposed_statement, {
          method: "model",
          outcome: "merged",
          verdict: sub.verdict,
          rationale: sub.rationale,
          group_id: check.group_id,
          checks: sub.checks,
        }),
      );
    }
  }
  const skipped = new Set(discovery.skipped.flatMap(groupRevisionIds));
  const singletons: DeduplicatedItem[] = [];
  for (const unit of discovery.units) {
    const headId = unit[0] as string;
    if (claimed.has(headId)) continue;
    const head = byRevision.get(headId) as SourceArgument;
    if (unit.length > 1) {
      consolidated.push(
        makeItem(unit, byRevision, normalizeText(head.statement), {
          method: "exact_match",
          outcome: "exact_match",
          verdict: "equivalent",
          rationale: "Identical statement text, epistemic kind and valence.",
          group_id: null,
          checks: [],
        }),
      );
      continue;
    }
    const found = context.get(headId);
    let verification: Verification;
    if (found?.[1]) {
      const [check, sub] = found;
      verification = {
        method: "model",
        outcome: sub.outcome,
        verdict: sub.verdict,
        rationale: sub.rationale,
        group_id: check.group_id,
        checks: sub.checks,
      };
    } else if (found) {
      verification = {
        method: "model",
        outcome: found[0].status,
        verdict: null,
        rationale: found[0].error || "",
        group_id: found[0].group_id,
        checks: [],
      };
    } else if (skipped.has(headId))
      verification = {
        method: "none",
        outcome: "candidate_limit",
        verdict: null,
        rationale: "",
        group_id: null,
        checks: [],
      };
    else
      verification = {
        method: "none",
        outcome: "no_candidate",
        verdict: null,
        rationale: "",
        group_id: null,
        checks: [],
      };
    singletons.push(makeItem([headId], byRevision, head.statement, verification));
  }
  const firstPos = (i: DeduplicatedItem) => Math.min(...i.member_revision_ids.map(pos));
  consolidated.sort((a, b) => firstPos(a) - firstPos(b));
  singletons.sort(
    (a, b) => pos(a.member_revision_ids[0] as string) - pos(b.member_revision_ids[0] as string),
  );
  accountFor(args, [...consolidated, ...singletons]);
  const total = (name: string) =>
    checks.reduce((n, c) => n + Math.trunc(Number(c.usage[name] ?? 0)), 0);
  return {
    recipe_id: RECIPE_ID,
    recipe_version: RECIPE_VERSION,
    prompt_id: VERIFY_PROMPT,
    consolidated,
    singletons,
    checks: [...checks],
    coverage: discovery.coverage,
    usage: {
      calls: checks.length,
      failed_calls: checks.filter((c) => c.status === "call_failed").length,
      malformed_answers: checks.filter((c) => c.status === "malformed").length,
      prompt_tokens: total("prompt_tokens"),
      completion_tokens: total("completion_tokens"),
      total_tokens: total("total_tokens"),
      model_attempts: total("attempts"),
    },
  };
}

export type Verifier = (request: VerificationRequest) => Promise<[unknown, Record<string, number>]>;

/**
 * Discovers candidates, verifies each group, applies the merge rules and accounts for
 * every input. A verifier that throws keeps its group separate and is recorded.
 */
export async function deduplicate(
  args: readonly SourceArgument[],
  params: DeduplicationParams,
  verifier: Verifier,
): Promise<DeduplicationResult> {
  const discovery = discoverCandidates(args, params);
  const byRevision = new Map(args.map((a) => [a.revision_id, a]));
  let next = 0;
  const checks: GroupCheck[] = new Array(discovery.groups.length);
  const worker = async () => {
    while (next < discovery.groups.length) {
      const index = next++;
      const group = discovery.groups[index] as CandidateGroup;
      const request = buildRequest(group, byRevision);
      try {
        const [raw, usage] = await verifier(request);
        checks[index] = checkAnswer(group, request, byRevision, raw, usage);
      } catch (err) {
        const e = err as Error;
        checks[index] = callFailed(
          group,
          `${e?.constructor?.name ?? "Error"}: ${e?.message ?? String(err)}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(params.concurrency, discovery.groups.length) }, worker),
  );
  return assembleResult(args, discovery, checks);
}

/** The output's identity: which source objects it stands for, whatever their revisions say. */
export const lineageKey = (memberObjectIds: Iterable<string>) =>
  `members:${sha256Hex(sortedStrings(memberObjectIds).join("\x1f")).slice(0, 40)}`;

const UNCERTAIN_OUTCOMES = new Set([
  "uncertain",
  "malformed",
  "call_failed",
  "candidate_limit",
  "checks_incomplete",
  "empty_statement",
]);

export function verificationStatus(v: Verification): string {
  if (v.outcome === "merged" || v.outcome === "exact_match") return "verified";
  if (UNCERTAIN_OUTCOMES.has(v.outcome)) return "uncertain";
  return "singleton";
}
