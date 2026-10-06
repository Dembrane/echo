/**
 * Scores one popcorn answer against the points a case expects. A point is kept when one
 * popcorn names its topic and carries every detail group; thin when a popcorn names the
 * topic but dropped the detail; missing otherwise. Each popcorn answers for one point at
 * most, so a phrase that fuses two points counts once.
 */

export interface EvalPoint {
  readonly id: string;
  readonly says: string;
  readonly topic: readonly string[];
  readonly detail: readonly (readonly string[])[];
}

export type PointStatus = "kept" | "thin" | "missing";

export interface PointResult {
  readonly id: string;
  readonly status: PointStatus;
  readonly phrase: string | null;
}

const anyOf = (patterns: readonly string[], text: string) =>
  patterns.some((p) => new RegExp(p, "iu").test(text));

const matchesTopic = (point: EvalPoint, phrase: string) => anyOf(point.topic, phrase);
const carriesDetail = (point: EvalPoint, phrase: string) =>
  point.detail.every((group) => anyOf(group, phrase));

/** Fewest candidates first, so a point with one possible phrase gets it. */
function assign(
  points: readonly EvalPoint[],
  phrases: readonly string[],
  fits: (point: EvalPoint, phrase: string) => boolean,
  taken: Set<number>,
): Map<string, number> {
  const out = new Map<string, number>();
  const candidates = points.map((point) => ({
    point,
    idx: phrases.map((p, i) => (fits(point, p) ? i : -1)).filter((i) => i >= 0),
  }));
  candidates.sort((a, b) => a.idx.length - b.idx.length);
  for (const { point, idx } of candidates) {
    const free = idx.find((i) => !taken.has(i));
    if (free === undefined) continue;
    taken.add(free);
    out.set(point.id, free);
  }
  return out;
}

export function scorePoints(
  points: readonly EvalPoint[],
  phrases: readonly string[],
): PointResult[] {
  const taken = new Set<number>();
  const kept = assign(
    points,
    phrases,
    (pt, p) => matchesTopic(pt, p) && carriesDetail(pt, p),
    taken,
  );
  const rest = points.filter((p) => !kept.has(p.id));
  const thin = assign(rest, phrases, matchesTopic, taken);
  return points.map((p) => {
    const k = kept.get(p.id);
    if (k !== undefined) return { id: p.id, status: "kept", phrase: phrases[k] ?? null };
    const t = thin.get(p.id);
    if (t !== undefined) return { id: p.id, status: "thin", phrase: phrases[t] ?? null };
    return { id: p.id, status: "missing", phrase: null };
  });
}
