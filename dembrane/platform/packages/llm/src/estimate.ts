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

// Past this many characters a prompt's text is sampled: encoding 1 MB blocks the loop ~100 ms.
export const ESTIMATE_SAMPLE_CHARS = 32_000;
const SAMPLE_WINDOWS = 16;

// Exact up to the cap; above it, evenly spaced windows scaled up to the whole length.
function estimateTexts(texts: readonly string[]): number {
  let total = 0;
  for (const t of texts) total += t.length;
  if (total <= ESTIMATE_SAMPLE_CHARS) {
    let n = 0;
    for (const t of texts) n += estimateText(t);
    return n;
  }
  const all = texts.join("\n");
  const width = Math.floor(ESTIMATE_SAMPLE_CHARS / SAMPLE_WINDOWS);
  const step = all.length / SAMPLE_WINDOWS;
  let sampled = 0;
  let tokens = 0;
  for (let i = 0; i < SAMPLE_WINDOWS; i++) {
    const start = Math.floor(i * step);
    const window = all.slice(start, start + width);
    sampled += window.length;
    tokens += estimateText(window);
  }
  return Math.ceil((tokens * all.length) / sampled);
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
  let audio = 0;
  for (const message of prompt) {
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case "text":
        case "reasoning":
          texts.push(part.text);
          break;
        case "file": {
          const bytes = part.mediaType.startsWith("audio/") ? fileBytes(part.data) : null;
          if (bytes) audio += Math.ceil(audioSecondsOf(bytes) * AUDIO_TOKENS_PER_SECOND);
          else if (part.data.type === "text") texts.push(part.data.text);
          break;
        }
        case "tool-call":
          texts.push(JSON.stringify(part.input) ?? "");
          break;
        case "tool-result":
          texts.push(
            part.output.type === "text" || part.output.type === "error-text"
              ? part.output.value
              : (JSON.stringify(part.output) ?? ""),
          );
          break;
      }
    }
  }
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
