import { expect, test } from "bun:test";
import { planPieces } from "@dembrane/audio";
import {
  ANSWER_SECONDS_PER_AUDIO_SECOND,
  FINAL_PIECE_SECONDS,
  pieceSeconds,
  REQUEST_TIMEOUT_SECONDS,
  requestLimits,
  SCALEWAY_MAX_BYTES,
  SCALEWAY_QUOTA_SECONDS,
  type SpeechProvider,
  TIMEOUT_SHARE,
} from "@dembrane/transcription";

// A small seeded generator: the same cases on every run.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("the limits are each the smallest of their measured causes", () => {
  const w = requestLimits("whisper");
  expect(w.maxSeconds).toBeLessThanOrEqual(SCALEWAY_QUOTA_SECONDS);
  expect(w.maxBytes).toBeLessThan(SCALEWAY_MAX_BYTES);
  for (const p of ["whisper", "gemini"] as SpeechProvider[]) {
    const l = requestLimits(p);
    // The expected answer time of the longest piece fits in the share of the timeout we allow.
    expect(l.maxSeconds * ANSWER_SECONDS_PER_AUDIO_SECOND[p]).toBeLessThanOrEqual(
      REQUEST_TIMEOUT_SECONDS * TIMEOUT_SHARE,
    );
    // A live chunk of 30 seconds is always sent as it is.
    expect(l.maxSeconds).toBeGreaterThanOrEqual(30);
  }
  expect(FINAL_PIECE_SECONDS).toBe(60);
});

test("any duration, bitrate and provider give pieces that respect every limit and cut at a pause where one exists", () => {
  const rand = rng(20261019);
  for (let n = 0; n < 600; n++) {
    const provider: SpeechProvider = rand() < 0.5 ? "whisper" : "gemini";
    const limits = requestLimits(provider);
    const duration = 1 + rand() ** 3 * 6 * 3600; // one second to six hours, mostly short
    const bitrate = 6_000 * 2 ** (rand() * 8.4); // 6 kbps to about 2 Mbps
    const bytes = (duration * bitrate) / 8;
    const finalPass = rand() < 0.3;
    // A pause every few seconds to every few minutes, or none at all.
    const gap = rand() < 0.2 ? Number.POSITIVE_INFINITY : 2 + rand() ** 2 * 400;
    const silences: { start: number; end: number }[] = [];
    for (let t = gap * rand(); t < duration; t += gap * (0.5 + rand())) {
      silences.push({ start: t, end: t + 0.3 + rand() * 2 });
      if (!Number.isFinite(gap)) break;
    }
    const quiet =
      rand() < 0.5
        ? Array.from({ length: Math.floor(duration / 4) }, (_, i) => ({ t: i * 4 + 1, level: -50 }))
        : [];
    const limit = pieceSeconds(
      limits,
      bytes,
      duration,
      finalPass ? FINAL_PIECE_SECONDS : undefined,
    );
    const pieces = planPieces(duration, silences, limit, quiet);

    let at = 0;
    for (const p of pieces) {
      expect(p.start).toBeCloseTo(at, 5);
      at = p.start + p.duration;
      const where = {
        provider,
        duration: Math.round(duration),
        bitrate: Math.round(bitrate),
        limit,
      };
      // Seconds: the quota, the answer time inside the timeout, and the final pass's own cap.
      expect({ ...where, ok: p.duration <= limit + 1e-6 }).toEqual({ ...where, ok: true });
      expect(p.duration).toBeLessThanOrEqual(limits.maxSeconds + 1e-6);
      expect(p.duration * ANSWER_SECONDS_PER_AUDIO_SECOND[provider]).toBeLessThanOrEqual(
        REQUEST_TIMEOUT_SECONDS * TIMEOUT_SHARE + 1e-6,
      );
      if (provider === "whisper") expect(p.duration).toBeLessThanOrEqual(SCALEWAY_QUOTA_SECONDS);
      if (finalPass) expect(p.duration).toBeLessThanOrEqual(FINAL_PIECE_SECONDS + 1e-6);
      // Bytes: at the file's own bitrate, whatever the format, a piece is under the byte limit
      // (a limit below one second of audio is the one case that cannot be met by cutting).
      if (bitrate / 8 <= limits.maxBytes)
        expect((p.duration * bitrate) / 8).toBeLessThanOrEqual(limits.maxBytes + 1);
    }
    expect(at).toBeCloseTo(duration, 5);

    // A cut falls inside a pause whenever the planner had one in reach; a hard cut means none was.
    let cursor = 0;
    for (const p of pieces.slice(0, -1)) {
      const end = p.start + p.duration;
      const reach = silences.filter(
        (s) =>
          (s.start + s.end) / 2 > cursor + Math.min(5, limit / 4) &&
          (s.start + s.end) / 2 <= cursor + limit,
      );
      if (reach.length) {
        expect(p.hardCut).toBe(false);
        expect(silences.some((s) => end >= s.start - 1e-6 && end <= s.end + 1e-6)).toBe(true);
      } else expect(p.hardCut).toBe(true);
      cursor = end;
    }
  }
});

test("the two extremes: a small file that holds many hours, and a big file that holds seconds", () => {
  for (const provider of ["whisper", "gemini"] as SpeechProvider[]) {
    const l = requestLimits(provider);
    // 8 kbps for 6 hours is 21.6 MB: small in bytes, long in seconds: cut by seconds.
    const low = pieceSeconds(l, (8_000 / 8) * 6 * 3600, 6 * 3600);
    expect(low).toBe(l.maxSeconds);
    // Uncompressed 24-bit stereo 48 kHz is 288 kB/s: ten minutes is 173 MB: cut by bytes.
    const wav = pieceSeconds(l, 288_000 * 600, 600);
    expect(wav).toBeLessThan(l.maxSeconds);
    expect(wav * 288_000).toBeLessThanOrEqual(l.maxBytes);
    expect(wav).toBeGreaterThanOrEqual(1);
  }
});
