import type { Silence } from "./ffmpeg";

export interface PlannedPiece {
  readonly start: number;
  readonly duration: number;
  /** True when no pause was found in reach and the piece ends at the size limit. */
  readonly hardCut: boolean;
}

/**
 * Cuts a recording of `duration` seconds into pieces no longer than `maxSeconds`, each
 * ending in the middle of a pause. Speech-to-text works on whole sentences: a cut inside a
 * word loses it. Among the pauses in the later half of the window the longest wins, so
 * the cut falls where the speaker really stopped. With no pause in reach (continuous
 * noise) the piece ends at the limit and says so; that is rare and the only fixed-time cut.
 * One piece when the whole recording fits.
 */
export function planPieces(
  duration: number,
  silences: readonly Silence[],
  maxSeconds: number,
): PlannedPiece[] {
  const pauses = silences
    .map((s) => ({ start: s.start, end: Math.min(s.end, duration), mid: 0 }))
    .map((s) => ({ ...s, mid: (s.start + s.end) / 2, length: s.end - s.start }))
    .filter((s) => s.length > 0);
  const pieces: PlannedPiece[] = [];
  let cursor = 0;
  while (duration - cursor > maxSeconds) {
    const limit = cursor + maxSeconds;
    const within = (from: number) => pauses.filter((p) => p.mid > from && p.mid <= limit);
    let pool = within(cursor + maxSeconds / 2);
    if (!pool.length) pool = within(cursor + Math.min(5, maxSeconds / 4));
    const best = pool.reduce<(typeof pool)[number] | null>(
      (a, b) => (a && a.length >= b.length ? a : b),
      null,
    );
    const cut = best ? best.mid : limit;
    pieces.push({ start: cursor, duration: cut - cursor, hardCut: !best });
    cursor = cut;
  }
  pieces.push({ start: cursor, duration: duration - cursor, hardCut: false });
  return pieces;
}
