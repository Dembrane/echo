import { popcornShared } from "@dembrane/analysis";
import { isRecord, type Json, pyStr } from "../py";
import { sha1Hex } from "./util";

/** What a large session's tensions keep between reads, and how it is keyed. */

// Past this many conversations trimPositions keeps one position each, so the positions grow
// with the session and comparing all of them grows with its square: the large path's line.
export const LARGE_SESSION_CONVERSATIONS: number = popcornShared.MAX_POSITIONS_TOTAL;
// A conversation's positions read this much of it, whatever the session's size.
export const POSITIONS_CHARS = 12_000;
export const CACHE_VERSION = "tensions-cache-v1";

export interface CachedPair {
  a: string;
  b: string;
  zero_sum: number;
  why: string;
  named_by: string[];
  /** The verification's answer, kept until either position changes. */
  verdict?: Json;
}
export interface TensionsCache {
  version: string;
  positions: Record<string, { key: string; found: Json[] }>;
  checked: string[];
  pairs: Record<string, CachedPair>;
}

export const isLarge = (conversations: number) => conversations > LARGE_SESSION_CONVERSATIONS;

/** The cache's version: a new collisions or verify prompt starts it over. */
export const cacheVersion = (...prompts: string[]) =>
  `${CACHE_VERSION}:${sha1Hex(prompts.join("\x1f"))}`;

export const emptyCache = (version = CACHE_VERSION): TensionsCache => ({
  version,
  positions: {},
  checked: [],
  pairs: {},
});

/** A kept cache of this version, or an empty one. */
export function cacheFrom(raw: unknown, version: string): TensionsCache {
  return isRecord(raw) && raw.version === version
    ? (raw as unknown as TensionsCache)
    : emptyCache(version);
}

export const positionsInput = (text: string) => [...text].slice(0, POSITIONS_CHARS).join("");
export const positionsKey = (prompt: string, input: string) => sha1Hex(`${prompt}\x1f${input}`);
export const positionKey = (tid: string, p: Json) =>
  sha1Hex(`${tid}\x1f${pyStr(p.position)}\x1f${pyStr(p.quote)}`);
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export const FOCAL_BATCH = 10;
export const NEIGHBOURS = 50;
// The most collisions calls one read makes; positions left over are asked about next read.
export const MAX_COLLISION_CALLS = 60;

function cosine(x: readonly number[], y: readonly number[]): number {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] as number;
    const b = y[i] as number;
    dot += a * b;
    nx += a * a;
    ny += b * b;
  }
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}

/** The ids a batch lists: its focal ids and each one's k nearest, in session order. */
export function neighbours(
  focal: readonly string[],
  vectors: ReadonlyMap<string, number[]>,
  all: readonly string[],
  k = NEIGHBOURS,
): string[] {
  const keep = new Set(focal);
  for (const f of focal) {
    const fv = vectors.get(f);
    if (!fv) continue;
    const near = all
      .filter((id) => id !== f && vectors.has(id))
      .map((id) => [id, cosine(fv, vectors.get(id) as number[])] as const)
      .sort((p, q) => q[1] - p[1])
      .slice(0, k);
    for (const [id] of near) keep.add(id);
  }
  return all.filter((id) => keep.has(id));
}

/** Drops what names a position the session no longer holds. */
export function prune(cache: TensionsCache, present: ReadonlySet<string>): void {
  cache.checked = cache.checked.filter((k) => present.has(k));
  for (const [k, p] of Object.entries(cache.pairs))
    if (!present.has(p.a) || !present.has(p.b)) delete cache.pairs[k];
}

/** Forgets a conversation that left the session: its positions and every pair naming them. */
export function forget(cache: TensionsCache, tid: string): void {
  const held = cache.positions[tid];
  if (!held) return;
  const gone = new Set(held.found.map((p) => positionKey(tid, p)));
  delete cache.positions[tid];
  cache.checked = cache.checked.filter((k) => !gone.has(k));
  for (const [k, p] of Object.entries(cache.pairs))
    if (gone.has(p.a) || gone.has(p.b)) delete cache.pairs[k];
}
