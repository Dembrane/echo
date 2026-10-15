import type { LanguageModelV4, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import {
  FALL_BACK_ON_REFUSAL,
  isRetryable,
  ModelRefusalError,
  type Models,
  speechHint,
} from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import { TranscriptParseError, TranscriptRefusedError } from "./errors";

/** One sentence of a transcript with where it starts and ends in the recording, in seconds. */
export interface Sentence {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** What a provider took for a piece of audio, for the cost per audio hour. */
export interface FinalUsage {
  readonly seconds: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface FinalPiece {
  /** The pieces' sentences with times counted from the start of this piece. */
  readonly sentences: readonly Sentence[];
  readonly usage: FinalUsage;
  readonly model: string | null;
}

export interface FinalInput {
  readonly audio: Uint8Array;
  /** Seconds of audio in this piece; Gemini's times are clamped to it. */
  readonly seconds: number;
  readonly language?: string | null;
  readonly hotwords?: readonly string[] | null;
  readonly signal?: AbortSignal;
}

export type FinalProvider = "gemini" | "whisper";

/**
 * Transcribes a whole recording or a silence-bounded piece of one into timed sentences.
 * The limits are what one request may hold; the caller plans pieces under them.
 */
export interface FinalTranscriber {
  readonly provider: FinalProvider;
  readonly model: string;
  readonly limits: { readonly maxBytes: number; readonly maxSeconds: number };
  transcribe(input: FinalInput): Promise<FinalPiece>;
}

// Scaleway takes 25 MB a request; keep a margin and keep one request well inside its
// 180 s timeout. Gemini takes 20 MB inline; 8 hours of audio tokens would fit but the
// answer (every word, with times) is the limit: about 35 minutes of speech stays far under
// 65k output tokens.
export const WHISPER_LIMITS = { maxBytes: 20 * 1024 * 1024, maxSeconds: 10 * 60 } as const;
export const GEMINI_LIMITS = { maxBytes: 18 * 1024 * 1024, maxSeconds: 35 * 60 } as const;

/** Whisper: its segments are the sentences, timed by the model itself. */
export class WhisperFinal implements FinalTranscriber {
  readonly provider = "whisper" as const;
  readonly limits = WHISPER_LIMITS;
  readonly model: string;
  private readonly stt: NonNullable<Models["speechToText"]>;

  constructor(models: Models) {
    if (!models.speechToText)
      throw new Error("the whisper final pass needs a speech-to-text model");
    this.stt = models.speechToText;
    this.model = this.stt.model;
  }

  async transcribe(input: FinalInput): Promise<FinalPiece> {
    const hotwords = input.hotwords?.length ? input.hotwords.join(", ") : "";
    const out = await this.stt.transcribeSegments(input.audio, {
      language: input.language ?? null,
      ...(hotwords && { prompt: hotwords }),
      ...(input.signal && { signal: input.signal }),
    });
    return {
      sentences: tidy(out.segments, input.seconds),
      usage: { seconds: out.seconds ?? input.seconds, inputTokens: null, outputTokens: null },
      model: this.model,
    };
  }
}

const SEGMENTS_SCHEMA = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          text: { type: "string" },
        },
        required: ["start", "end", "text"],
      },
    },
  },
  required: ["segments"],
} as const;

const PROVIDER_OPTIONS = { ...FALL_BACK_ON_REFUSAL, vertex: { threshold: "OFF" } };

/** The instruction for a timed, word for word transcript; exported so a measurement can print it. */
export function segmentsPrompt(opts: { language?: string | null; hotwords?: string }): string {
  return [
    "Transcribe this recording word for word, in the language that is spoken.",
    "Do not summarise, translate, paraphrase or correct grammar. Keep filler words and repetitions.",
    "Split the transcript into sentences. For each sentence give `start` and `end`: the seconds from the very start of the recording at which the first and the last word of that sentence are spoken, as numbers with one decimal.",
    "Sentences are in order and do not overlap. Use no speaker labels and no markup.",
    opts.language ? `The spoken language is expected to be: ${opts.language}.` : "",
    opts.hotwords ? `Names and terms that may occur, spelled this way: ${opts.hotwords}.` : "",
    'Answer as JSON: {"segments": [{"start": 0.0, "end": 4.2, "text": "..."}]}. If nobody speaks, answer {"segments": []}.',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Gemini: one call on the audio asking for timed sentences. */
export class GeminiFinal implements FinalTranscriber {
  readonly provider = "gemini" as const;
  readonly limits = GEMINI_LIMITS;
  model = "gemini";

  constructor(
    private readonly models: Models,
    private readonly logger: Logger,
  ) {}

  async transcribe(input: FinalInput): Promise<FinalPiece> {
    const prompt = segmentsPrompt({
      language: input.language ?? null,
      hotwords: input.hotwords?.length ? input.hotwords.join(", ") : "",
    });
    // A bad payload is retried once; a truncated one is not, it would truncate again.
    let last: TranscriptParseError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.call(prompt, input);
      try {
        const segments = parseSegments(r.text, r.finishReason);
        this.model = r.model ?? this.model;
        return {
          sentences: tidy(segments, input.seconds),
          usage: {
            seconds: input.seconds,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
          },
          model: r.model,
        };
      } catch (err) {
        if (!(err instanceof TranscriptParseError)) throw err;
        last = err;
        this.logger.warn(
          { attempt: attempt + 1, err: err.message },
          "timed transcript parse failed",
        );
        if (err.isTruncated) break;
      }
    }
    throw last ?? new TranscriptParseError("timed transcript never ran");
  }

  private async call(prompt: string, input: FinalInput) {
    const run = async (m: LanguageModelV4) => {
      let r: LanguageModelV4GenerateResult;
      try {
        r = await m.doGenerate({
          prompt: [
            { role: "system", content: prompt },
            {
              role: "user",
              content: [
                {
                  type: "file",
                  data: { type: "data", data: input.audio },
                  mediaType: "audio/mp3",
                },
              ],
            },
          ],
          responseFormat: { type: "json", schema: SEGMENTS_SCHEMA as never },
          providerOptions: { ...PROVIDER_OPTIONS, ...speechHint(this.models, input.language) },
          ...(input.signal && { abortSignal: input.signal }),
        });
      } catch (err) {
        if (err instanceof ModelRefusalError) throw new TranscriptRefusedError(err.finishReason);
        throw err;
      }
      const text = r.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const raw = r.finishReason.raw ?? r.finishReason.unified;
      const usage = r.usage as unknown as {
        inputTokens?: { total?: number } | number;
        outputTokens?: { total?: number } | number;
      };
      const count = (v: { total?: number } | number | undefined) =>
        typeof v === "number" ? v : typeof v?.total === "number" ? v.total : null;
      return {
        text,
        finishReason: raw ? String(raw).toLowerCase() : null,
        model: r.response?.modelId ?? null,
        inputTokens: count(usage?.inputTokens),
        outputTokens: count(usage?.outputTokens),
      };
    };
    try {
      return await run(this.models.model("multi_modal_pro"));
    } catch (err) {
      if (!isRetryable(err)) throw err;
      this.logger.warn(
        { err: (err as Error).message },
        "timed transcript falls back to multi_modal_fast",
      );
      return run(this.models.model("multi_modal_fast"));
    }
  }
}

/** Seconds from a number, "83.5", or a clock reading such as "01:23.5". */
export function toSeconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const parts = v.trim().split(":");
  if (!parts.length || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((t, p) => t * 60 + Number(p), 0);
}

/** The model's JSON as segments; a payload without a segments list is a parse failure. */
export function parseSegments(content: string, finishReason: string | null): Sentence[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new TranscriptParseError(
      `Unparseable timed transcript (finish_reason=${finishReason}, ${content.length} chars): ${(err as Error).message}`,
      finishReason,
    );
  }
  const list = (parsed as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(list))
    throw new TranscriptParseError(
      `Timed transcript missing segments (finish_reason=${finishReason})`,
      finishReason,
    );
  const out: Sentence[] = [];
  for (const s of list as Record<string, unknown>[]) {
    const start = toSeconds(s?.start);
    const end = toSeconds(s?.end);
    const text = typeof s?.text === "string" ? s.text.trim() : "";
    if (text && start !== null && end !== null) out.push({ start, end, text });
  }
  return out;
}

/**
 * Sentences in order, inside the piece, each with a positive length, none overlapping the
 * one before. Models drift: a sentence that ends before it starts, or past the audio, is
 * pulled back rather than dropped, since its text still belongs in the transcript.
 */
export function tidy(sentences: readonly Sentence[], seconds: number): Sentence[] {
  const sorted = [...sentences].sort((a, b) => a.start - b.start);
  const out: Sentence[] = [];
  let floor = 0;
  for (const s of sorted) {
    const start = Math.min(Math.max(s.start, floor), seconds);
    const end = Math.min(Math.max(s.end, start), seconds);
    out.push({ start: round(start), end: round(end), text: s.text });
    floor = end;
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
