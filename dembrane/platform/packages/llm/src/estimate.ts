import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import { mp3Seconds } from "./audio-length";

/** Gemini bills audio input at 32 tokens per second. */
export const AUDIO_TOKENS_PER_SECOND = 32;

let encoder: Tiktoken | null = null;

/** Tokens in a text by tiktoken cl100k, the local tokenizer chats already sizes context with. */
export function estimateText(text: string): number {
  if (!text) return 0;
  encoder ??= new Tiktoken(cl100k);
  // Special-token text such as "<|endoftext|>" is counted as plain text, never a throw.
  return encoder.encode(text, [], []).length;
}

/** Seconds of audio: the mp3's frames when readable, else its size at 64 kbps (as compat.ts). */
export function audioSecondsOf(bytes: Uint8Array): number {
  return mp3Seconds(bytes) ?? bytes.byteLength / 8000;
}

type Estimate = { inputTokens: number; audioInputTokens: number };

// About 5-10 ms of encoding on any script; a prompt that costs more is sampled in tiles.
export const ESTIMATE_COST_BUDGET = 140_000;
const TILE = 64;
const SNAP = 32;
const MIN_TILES = 4;
// Each encode call has a fixed cost, so many tiny parts are not free either.
const SLICE_COST = 20;
// BPE cost grows with the square of a piece's UTF-8 length, so longer runs are counted in parts.
const PIECE_BYTES = 48;
const LONG_RUN = /\p{L}{17,}|[^\s\p{L}\p{N}]{17,}|\s{17,}/gu;
const RUNS = /\p{L}+|\s+|\p{N}+|[^\s\p{L}\p{N}]+/gu;
const LETTER = /\p{L}/u;
// UTF-8 bytes per UTF-16 unit; a surrogate half is half of a 4-byte character.
const bytesOf = (c: number) => (c < 0x80 ? 1 : c < 0x800 || (c >= 0xd800 && c < 0xe000) ? 2 : 3);

// Encoding cost of a slice in ~50 ns units: a piece costs its bytes times its byte length (BPE),
// plus a floor for characters no single token covers (CJK and the like).
function costOf(s: string): number {
  let cost = SLICE_COST;
  for (const m of s.matchAll(RUNS)) {
    const run = m[0];
    const digits = run.charCodeAt(0) >= 0x30 && run.charCodeAt(0) <= 0x39;
    let floor = 0;
    let bytes = 0;
    for (let k = 0; k < run.length; k++) {
      const c = run.charCodeAt(k);
      if (c >= 0x800) floor += 100;
      bytes += bytesOf(c);
      if (bytes >= PIECE_BYTES || k === run.length - 1) {
        cost += floor + bytes * (4 + (digits ? 0 : bytes));
        floor = 0;
        bytes = 0;
      }
    }
  }
  return cost;
}

// Tokens of a slice; long runs (CJK, dash rules, box drawing, blank lines) are cut, so no piece is costly.
function boundedCount(s: string): number {
  let n = 0;
  let from = 0;
  for (const m of s.matchAll(LONG_RUN)) {
    const step = Math.floor(PIECE_BYTES / bytesOf(m[0].charCodeAt(0)));
    for (let at = m.index + step; at < m.index + m[0].length; at += step) {
      // Never between the halves of a surrogate pair.
      const c = s.charCodeAt(at - 1);
      const cut = c >= 0xd800 && c < 0xdc00 ? at + 1 : at;
      n += estimateText(s.slice(from, cut));
      from = cut;
    }
  }
  return n + estimateText(s.slice(from));
}

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

// A tile edge near p where tiktoken's pre-split already breaks, so prose counts exactly.
function edge(s: string, p: number): number {
  if (p <= 0) return 0;
  if (p >= s.length) return s.length;
  for (let i = p; i < Math.min(p + SNAP, s.length); i++) {
    const prev = s[i - 1] as string;
    const ch = s[i] as string;
    if (LETTER.test(prev) && !LETTER.test(ch)) return i;
    if (ch === " " && !isSpace(prev) && !isSpace(s[i + 1])) return i;
    if (prev === "\n" && !isSpace(ch)) return i;
  }
  const c = s.charCodeAt(p - 1);
  return c >= 0xd800 && c < 0xdc00 ? p + 1 : p;
}

// A seeded shuffle drawn one index at a time: random positions, so no regular layout aliases.
function* shuffled(n: number): Generator<number> {
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  let x = 0x9e3779b9 ^ n;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = i + Math.floor((x / 2 ** 32) * (n - i));
    const pick = idx[j] as number;
    idx[j] = idx[i] as number;
    idx[i] = pick;
    yield pick;
  }
}

interface Stratum {
  // Tiles as [part, from] pairs.
  readonly tiles: number[];
  chars: number;
  sampled: number;
  tokens: number;
  taken: number;
  stopped: boolean;
}

/**
 * Exact within the budget for prose and code (long runs are cut, so they drift a little). Past
 * it, 64-character tiles are sampled per script class (Latin, other alphabets, CJK and the
 * like), and each class is scaled to its length.
 */
function estimateTexts(texts: readonly string[]): number {
  const strata: Stratum[] = [0, 1, 2].map(() => ({
    tiles: [],
    chars: 0,
    sampled: 0,
    tokens: 0,
    taken: 0,
    stopped: false,
  }));
  texts.forEach((t, i) => {
    for (let from = 0; from < t.length; from += TILE) {
      const to = Math.min(from + TILE, t.length);
      let latin = 0;
      let alpha = 0;
      let heavy = 0;
      for (let k = from; k < to; k += 16) {
        const c = t.charCodeAt(k);
        if (c < 0x80) latin++;
        else if (c < 0x800) alpha++;
        else heavy++;
      }
      const st = strata[heavy > latin && heavy >= alpha ? 2 : alpha > latin ? 1 : 0] as Stratum;
      st.tiles.push(i, from);
      st.chars += to - from;
    }
  });
  let spent = 0;
  const live = strata.filter((st) => st.tiles.length > 0);
  const orders = live.map((st) => shuffled(st.tiles.length / 2));
  // Round robin, so every class gets as many tiles as the others while the budget lasts.
  for (let more = true; more; ) {
    more = false;
    live.forEach((st, si) => {
      if (st.stopped || st.taken * 2 === st.tiles.length) return;
      const k = 2 * ((orders[si] as Generator<number>).next().value as number);
      const t = texts[st.tiles[k] as number] as string;
      const from = st.tiles[k + 1] as number;
      // Both neighbours snap the same point, so the tiles still cover the part exactly.
      const slice = t.slice(edge(t, from), edge(t, from + TILE));
      const cost = costOf(slice);
      if (st.taken >= MIN_TILES && spent + cost > ESTIMATE_COST_BUDGET) {
        st.stopped = true;
        return;
      }
      spent += cost;
      st.taken++;
      st.sampled += slice.length;
      st.tokens += boundedCount(slice);
      more = true;
    });
  }
  let n = 0;
  for (const st of live)
    n +=
      st.taken * 2 === st.tiles.length
        ? st.tokens
        : (st.tokens * st.chars) / Math.max(1, st.sampled);
  return Math.ceil(n);
}

// Every attempt of one call shares its prompt: count it once.
const counted = new WeakMap<LanguageModelV4Prompt, { text: number; audio: number }>();

/**
 * Input tokens of a prompt: its text by cl100k, its inline audio by duration; audio included
 * in the total. `audio: false` for a model that reads a transcript instead (openai-compatible).
 */
export function estimateInput(
  prompt: LanguageModelV4Prompt,
  { audio: withAudio = true }: { audio?: boolean } = {},
): Estimate {
  const { text, audio } = counted.get(prompt) ?? countPrompt(prompt);
  const audioTokens = withAudio ? audio : 0;
  return { inputTokens: text + audioTokens, audioInputTokens: audioTokens };
}

function countPrompt(prompt: LanguageModelV4Prompt): { text: number; audio: number } {
  const texts: string[] = [];
  // Tiny parts in a row are joined with a space: one encode instead of thousands, about the same count.
  let small = "";
  const add = (t: string) => {
    if (t.length < 16) {
      if (t) small = small ? `${small} ${t}` : t;
      return;
    }
    if (small) texts.push(small);
    small = "";
    texts.push(t);
  };
  let audio = 0;
  for (const message of prompt) {
    if (typeof message.content === "string") {
      add(message.content);
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case "text":
        case "reasoning":
          add(part.text);
          break;
        case "file": {
          const bytes = part.mediaType.startsWith("audio/") ? fileBytes(part.data) : null;
          if (bytes) audio += Math.ceil(audioSecondsOf(bytes) * AUDIO_TOKENS_PER_SECOND);
          else if (part.data.type === "text") add(part.data.text);
          break;
        }
        case "tool-call":
          add(JSON.stringify(part.input) ?? "");
          break;
        case "tool-result":
          add(
            part.output.type === "text" || part.output.type === "error-text"
              ? part.output.value
              : (JSON.stringify(part.output) ?? ""),
          );
          break;
      }
    }
  }
  if (small) texts.push(small);
  const count = { text: estimateTexts(texts), audio };
  counted.set(prompt, count);
  return count;
}

function fileBytes(data: { type: string; data?: unknown }): Uint8Array | null {
  if (data.type !== "data") return null;
  if (data.data instanceof Uint8Array) return data.data;
  if (typeof data.data === "string") return Buffer.from(data.data, "base64");
  return null;
}

// Failures before a connection opened: the request never left this machine.
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "ConnectionRefused",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "FailedToOpenSocket",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// Errors thrown before the model request was sent (the compat speech step, for one).
const notSent = new WeakSet<object>();

/** Marks an error as thrown before the model request left, so its call costs nothing. */
export function markNotSent<E>(err: E): E {
  if (err && typeof err === "object") notSent.add(err);
  return err;
}

/** False when the provider never accepted the call: a 4xx (429 included) or a connection error. */
export function reachedProvider(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (notSent.has(current)) return false;
    const e = current as { statusCode?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.statusCode === "number") return !(e.statusCode >= 400 && e.statusCode < 500);
    if (typeof e.code === "string" && NOT_CONNECTED.has(e.code)) return false;
    current = e.cause;
  }
  return true;
}
