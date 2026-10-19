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
import {
  type Pauser,
  type RetryPolicy,
  type RetryStats,
  type SpanCutter,
  transcribeChecked,
} from "./speech-retry";

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
  /** What the confidence retries did for this piece, when they were on. */
  readonly retry?: RetryStats;
}

export interface FinalInput {
  readonly audio: Uint8Array;
  /** Seconds of audio in this piece; Gemini's times are clamped to it. */
  readonly seconds: number;
  readonly language?: string | null;
  readonly hotwords?: readonly string[] | null;
  readonly signal?: AbortSignal;
  /** Cuts a stretch out of the audio sent, for the retries of doubtful stretches. */
  readonly cutSpan?: SpanCutter;
  readonly pauses?: Pauser;
  readonly priority?: "final" | "upload";
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

// Scaleway takes 25 MB a request; keep a margin and keep one request well inside its 180 s
// timeout. Whisper times its own segments, but over a five minute file they ran 2.7 seconds off
// on median (6.8 at worst), over a piece of a minute 0.2 seconds (1.4 at worst), and the word
// error rate was no worse.
export const WHISPER_LIMITS = { maxBytes: 20 * 1024 * 1024, maxSeconds: 60 } as const;
// Gemini takes 20 MB inline, but its clock is the limit: over a five minute file its
// timestamps ran 10 to 50 percent fast with errors of 7 to 12 seconds, over one minute they
// stay within 2 seconds after the piece's times are pulled back to its length. Pieces are cut
// where nobody speaks, so no word is split and the text is as good as one call on the whole
// file.
export const GEMINI_LIMITS = { maxBytes: 18 * 1024 * 1024, maxSeconds: 60 } as const;

/** Whisper: its segments are the sentences, timed by the model itself. */
export class WhisperFinal implements FinalTranscriber {
  readonly provider = "whisper" as const;
  readonly limits: FinalTranscriber["limits"];
  readonly model: string;
  private readonly stt: NonNullable<Models["speechToText"]>;

  private readonly retry: RetryPolicy | null;

  constructor(models: Models, opts: { maxSeconds?: number; retry?: RetryPolicy | null } = {}) {
    this.retry = opts.retry ?? null;
    this.limits = {
      maxBytes: WHISPER_LIMITS.maxBytes,
      maxSeconds: opts.maxSeconds ?? WHISPER_LIMITS.maxSeconds,
    };
    if (!models.speechToText)
      throw new Error("the whisper final pass needs a speech-to-text model");
    this.stt = models.speechToText;
    this.model = this.stt.model;
  }

  async transcribe(input: FinalInput): Promise<FinalPiece> {
    // No prompt: asked for segments with a list of key terms as its prompt, Scaleway's
    // whisper-large-v3 returned about half the words of real meetings (whole pieces came back
    // empty); without the prompt nothing was lost. Next: spell key terms in a text pass after it.
    const { result: out, stats } = await transcribeChecked(
      this.stt,
      input.audio,
      {
        language: input.language ?? null,
        ...(input.signal && { signal: input.signal }),
        priority: input.priority ?? "final",
        seconds: input.seconds,
      },
      input.seconds,
      input.cutSpan,
      this.retry,
      undefined,
      input.pauses,
    );
    return {
      sentences: tidy(out.segments, input.seconds),
      usage: { seconds: out.seconds ?? input.seconds, inputTokens: null, outputTokens: null },
      model: this.model,
      ...(this.retry && input.cutSpan && { retry: stats }),
    };
  }
}

const segmentsSchema = (time: "number" | "string") =>
  ({
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: { start: { type: time }, end: { type: time }, text: { type: "string" } },
          required: ["start", "end", "text"],
        },
      },
    },
    required: ["segments"],
  }) as const;

/** How the model is asked to write times: seconds as numbers, or a clock reading. */
export type TimeFormat = "seconds" | "clock";

const PROVIDER_OPTIONS = { ...FALL_BACK_ON_REFUSAL, vertex: { threshold: "OFF" } };

/** The instruction for a timed, word for word transcript; exported so a measurement can print it. */
export function segmentsPrompt(opts: {
  language?: string | null;
  hotwords?: string;
  timeFormat?: TimeFormat;
}): string {
  const times =
    opts.timeFormat === "clock"
      ? "as a clock reading MM:SS.s from the very start of the recording, for example 01:23.4"
      : "as seconds from the very start of the recording, numbers with one decimal";
  return [
    "Transcribe this recording word for word, in the language that is spoken.",
    "Do not summarise, translate, paraphrase or correct grammar. Keep filler words and repetitions.",
    `Split the transcript into sentences. For each sentence give \`start\` and \`end\`: the moments at which the first and the last word of that sentence are spoken, ${times}.`,
    "Sentences are in order and do not overlap. Use no speaker labels and no markup.",
    opts.language ? `The spoken language is expected to be: ${opts.language}.` : "",
    opts.hotwords ? `Names and terms that may occur, spelled this way: ${opts.hotwords}.` : "",
    'Answer as JSON: {"segments": [{"start": ..., "end": ..., "text": "..."}]}. If nobody speaks, answer {"segments": []}.',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Gemini: one call on the audio asking for timed sentences. */
export class GeminiFinal implements FinalTranscriber {
  readonly provider = "gemini" as const;
  readonly limits: FinalTranscriber["limits"];
  model = "gemini";

  constructor(
    private readonly models: Models,
    private readonly logger: Logger,
    private readonly opts: {
      timeFormat?: TimeFormat;
      /** Longest piece in seconds; the model's clock drifts over a long file, so shorter is truer. */
      maxSeconds?: number;
      /** Pull a piece's times back when the model's last sentence ends after the audio does (default on). */
      rescale?: boolean;
      /** Vertex's switch that makes the model read audio with a clock; off leaves its default. */
      audioTimestamp?: boolean;
    } = {},
  ) {
    this.limits = {
      maxBytes: GEMINI_LIMITS.maxBytes,
      maxSeconds: opts.maxSeconds ?? GEMINI_LIMITS.maxSeconds,
    };
  }

  async transcribe(input: FinalInput): Promise<FinalPiece> {
    const prompt = segmentsPrompt({
      language: input.language ?? null,
      hotwords: input.hotwords?.length ? input.hotwords.join(", ") : "",
      ...(this.opts.timeFormat && { timeFormat: this.opts.timeFormat }),
    });
    // A bad payload is retried once; a truncated one is not, it would truncate again.
    let last: TranscriptParseError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const began = Date.now();
      const r = await this.call(prompt, input);
      this.logger.info(
        {
          signal: "speech.request",
          provider: "gemini",
          model: r.model,
          audioSeconds: input.seconds,
          estimated: false,
          bytes: input.audio.byteLength,
          ms: Date.now() - began,
          status: 200,
          attempt: attempt + 1,
          path: input.priority ?? "final",
        },
        "speech request",
      );
      try {
        const segments = rescaleToPiece(
          parseSegments(r.text, r.finishReason),
          input.seconds,
          this.opts.rescale ?? true,
        );
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
          responseFormat: {
            type: "json",
            schema: segmentsSchema(this.opts.timeFormat === "clock" ? "string" : "number") as never,
          },
          providerOptions: {
            ...PROVIDER_OPTIONS,
            ...(this.opts.audioTimestamp && {
              vertex: { ...PROVIDER_OPTIONS.vertex, audioTimestamp: true },
            }),
            ...speechHint(this.models, input.language),
          },
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

/**
 * The model's clock runs fast over a long recording, so its last sentence can end after the
 * audio does. Times are compressed by the same factor so the last sentence ends with the
 * piece; a piece whose last sentence ends inside the audio is left as the model gave it.
 */
export function rescaleToPiece(
  sentences: readonly Sentence[],
  seconds: number,
  on: boolean,
): Sentence[] {
  const last = sentences.reduce((m, s) => Math.max(m, s.end), 0);
  if (!on || last <= seconds || seconds <= 0) return [...sentences];
  const k = seconds / last;
  return sentences.map((s) => ({ start: s.start * k, end: s.end * k, text: s.text }));
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
