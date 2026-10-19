import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { retryAfterMs, type SpeechGate, type SpeechPriority } from "./speech-gate";

/** Connection to an OpenAI-compatible API (Scaleway Generative APIs, for example). */
export interface CompatEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Speech-to-text model behind `/audio/transcriptions`. */
  readonly transcriptionModel: string;
  /** Reasoning effort for calls that do not set their own; unset leaves the model default. */
  readonly reasoningEffort?: string | undefined;
  /** The provider's answer-length ceiling; a call asking for more is sent with this. */
  readonly maxOutputTokens?: number | undefined;
  /** Injected so tests can assert requests without the network. */
  readonly fetch?: typeof fetch | undefined;
  /** Paces speech-to-text calls against the provider's audio-seconds-per-minute limit. */
  readonly speechGate?: SpeechGate | undefined;
}

/** Who a speech-to-text call is for and how much audio it holds, for the pacing. */
export interface SpeechCall {
  readonly priority?: SpeechPriority | undefined;
  readonly seconds?: number | undefined;
}

/**
 * Per-call hint for the audio step. Features that know the spoken language pass it as
 * `providerOptions.echo.language`; it is read and removed before the provider sees the call.
 */
export const echoOptions = (language: string | null | undefined) =>
  language ? { echo: { language } } : {};

/** "nl-NL" and "NL" both become "nl", the form speech-to-text endpoints take. */
export function languageHint(language: unknown): string | undefined {
  if (typeof language !== "string") return undefined;
  const base = language.trim().split(/[-_]/)[0]?.toLowerCase();
  return base && /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

type Sniffed = { ext: string; type: string };

/** The container by its first bytes: the stored files are not all mp3, whatever they are labelled. */
function sniff(b: Uint8Array): Sniffed {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { ext: "wav", type: "audio/wav" };
  if (ascii(0, 4) === "OggS") return { ext: "ogg", type: "audio/ogg" };
  if (ascii(0, 4) === "fLaC") return { ext: "flac", type: "audio/flac" };
  if (ascii(4, 8) === "ftyp") return { ext: "m4a", type: "audio/mp4" };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return { ext: "webm", type: "audio/webm" };
  return { ext: "mp3", type: "audio/mpeg" };
}

/** Largest file `/audio/transcriptions` takes on Scaleway Generative APIs (serverless). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** One transcription request may not hold a worker longer than this. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;
/** A 429 is answered this many times in one call before the step's own retry takes over. */
const RATE_LIMIT_ATTEMPTS = 6;

/** A loop, not a regex: a regex over a configured URL is flagged as slow on many slashes. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/** A stretch of speech with its start and end in seconds from the start of the audio sent. */
export interface SpeechSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Whisper's own confidence in the segment (mean log probability of its tokens; about -0.3 is clean, below -1 is doubtful). */
  readonly avgLogprob?: number;
  /** How compressible the text is: over 2.4 is Whisper looping on itself. */
  readonly compressionRatio?: number;
  /** Chance that the segment holds no speech. */
  readonly noSpeechProb?: number;
}

export interface SpeechResult {
  readonly text: string;
  readonly segments: readonly SpeechSegment[];
  /** Seconds of audio the provider billed, when it says. */
  readonly seconds: number | null;
  /** The language Whisper reported for the audio sent. */
  readonly language?: string | undefined;
}

async function requestTranscription(
  ep: CompatEndpoint,
  audio: Uint8Array,
  format: "json" | "verbose_json",
  language?: string,
  signal?: AbortSignal,
  prompt?: string,
  temperature?: number,
  call: SpeechCall = {},
): Promise<Record<string, unknown>> {
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    const err = new Error(
      `audio is ${audio.byteLength} bytes, above the ${MAX_AUDIO_BYTES} the speech-to-text endpoint takes`,
    );
    (err as { isRetryable?: boolean }).isRetryable = false;
    throw err;
  }
  const kind = sniff(audio);
  const form = new FormData();
  form.set("model", ep.transcriptionModel);
  form.set("response_format", format);
  if (language) form.set("language", language);
  if (prompt) form.set("prompt", prompt);
  if (temperature !== undefined) form.set("temperature", String(temperature));
  form.set("file", new Blob([audio as never], { type: kind.type }), `audio.${kind.ext}`);
  const request = () =>
    (ep.fetch ?? fetch)(`${withoutTrailingSlashes(ep.baseUrl)}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ep.apiKey}` },
      body: form,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)])
        : AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  // Without a length, a minute of audio is about this many bytes of compressed speech.
  const seconds = call.seconds ?? Math.min(900, Math.max(1, audio.byteLength / 8000));
  const gate = ep.speechGate;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = gate ? await gate.run(seconds, call.priority ?? "live", request) : await request();
    if (res.status !== 429 || attempt >= RATE_LIMIT_ATTEMPTS - 1) break;
    // The org limit answered: everybody in this process waits as long as it asks (or, without
    // a hint, a growing while), then goes again in priority order.
    const wait =
      retryAfterMs(res.headers.get("retry-after")) ??
      Math.min(60_000, 5_000 * 2 ** attempt) + Math.random() * 1_000;
    await res.body?.cancel().catch(() => undefined);
    if (gate) gate.pause(wait);
    else await new Promise((r) => setTimeout(r, wait));
  }
  if (!res.ok) {
    const err = new Error(`transcription ${res.status}: ${(await res.text()).slice(0, 300)}`);
    // Rate limits and server faults are worth another try; a bad request is not.
    (err as { isRetryable?: boolean }).isRetryable =
      res.status === 408 || res.status === 429 || res.status >= 500;
    throw err;
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Audio to text on the endpoint's `/audio/transcriptions`. */
export async function transcribeAudio(
  ep: CompatEndpoint,
  audio: Uint8Array,
  language?: string,
  signal?: AbortSignal,
  /** Words the speaker is likely to say (names, terms): Whisper spells them as given. */
  prompt?: string,
  call?: SpeechCall,
): Promise<string> {
  // verbose_json, though only the text is used: for the same 30 second pieces of a recording that
  // switches language, plain json returned 130 to 147 words and verbose_json 173 to 178.
  const body = await requestTranscription(
    ep,
    audio,
    "verbose_json",
    language,
    signal,
    prompt,
    undefined,
    call,
  );
  return typeof body.text === "string" ? body.text.trim() : "";
}

/**
 * The same call asking for segments: the text split where the model heard a sentence end,
 * each with its start and end. The final transcript's player highlights these.
 */
export async function transcribeSegments(
  ep: CompatEndpoint,
  audio: Uint8Array,
  language?: string,
  signal?: AbortSignal,
  prompt?: string,
  temperature?: number,
  call?: SpeechCall,
): Promise<SpeechResult> {
  const body = await requestTranscription(
    ep,
    audio,
    "verbose_json",
    language,
    signal,
    prompt,
    temperature,
    call,
  );
  const raw = Array.isArray(body.segments) ? (body.segments as Record<string, unknown>[]) : [];
  const segments = raw
    .map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: typeof s.text === "string" ? s.text.trim() : "",
      ...(Number.isFinite(Number(s.avg_logprob)) &&
        s.avg_logprob !== null && { avgLogprob: Number(s.avg_logprob) }),
      ...(Number.isFinite(Number(s.compression_ratio)) &&
        s.compression_ratio !== null && { compressionRatio: Number(s.compression_ratio) }),
      ...(Number.isFinite(Number(s.no_speech_prob)) &&
        s.no_speech_prob !== null && { noSpeechProb: Number(s.no_speech_prob) }),
    }))
    .filter((s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end));
  const duration = Number(body.duration);
  return {
    text: typeof body.text === "string" ? body.text.trim() : segments.map((s) => s.text).join(" "),
    segments,
    seconds: Number.isFinite(duration) ? duration : null,
    ...(typeof body.language === "string" && { language: body.language }),
  };
}

function audioBytes(part: { data: unknown }): Uint8Array | null {
  const d = part.data as unknown;
  if (d instanceof Uint8Array) return d;
  if (typeof d === "string") return Uint8Array.from(Buffer.from(d, "base64"));
  if (d && typeof d === "object" && (d as { type?: string }).type === "data") {
    const inner = (d as { data: unknown }).data;
    if (inner instanceof Uint8Array) return inner;
    if (typeof inner === "string") return Uint8Array.from(Buffer.from(inner, "base64"));
  }
  return null;
}

/** Replaces every audio file part by the text a speech-to-text model heard in it. */
export async function audioToText(
  ep: CompatEndpoint,
  prompt: LanguageModelV4Prompt,
  language?: string,
  signal?: AbortSignal,
): Promise<LanguageModelV4Prompt> {
  const out: LanguageModelV4Prompt = [];
  for (const message of prompt) {
    if (message.role === "system" || typeof message.content === "string") {
      out.push(message);
      continue;
    }
    const parts = await Promise.all(
      (message.content as { type: string; mediaType?: string; data?: unknown }[]).map(
        async (part) => {
          if (part.type !== "file" || !part.mediaType?.startsWith("audio/")) return part;
          const bytes = audioBytes(part as { data: unknown });
          if (!bytes) return part;
          const text = await transcribeAudio(ep, bytes, language, signal);
          return { type: "text", text: `Transcript of the audio: ${text || "(no speech heard)"}` };
        },
      ),
    );
    out.push({ ...message, content: parts } as never);
  }
  return out;
}

/**
 * Vertex thinking budgets mapped to a reasoning effort: 0 is off. A positive budget has no
 * exact counterpart (the efforts a model takes differ), so it keeps the configured effort,
 * or the model default when none is set.
 */
function effortFor(options: LanguageModelV4CallOptions, fallback: string | undefined) {
  const po = (options.providerOptions ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const direct = po.openaiCompatible?.reasoningEffort;
  if (typeof direct === "string") return direct;
  const cfg = (po.vertex?.thinkingConfig ?? po.google?.thinkingConfig) as
    | { thinkingBudget?: number }
    | undefined;
  const budget = cfg?.thinkingBudget;
  if (typeof budget === "number" && budget <= 0) return "none";
  return fallback;
}

/**
 * What a call looks like to an OpenAI-compatible provider: the Vertex-only provider
 * options and the Google Search tool are dropped, and a thinking budget becomes a
 * reasoning effort. Audio parts are handled separately, by `audioToText`. The answer length
 * is capped at the provider's ceiling: the limits were sized for Gemini, and Scaleway refuses
 * a call that asks for more than the model allows instead of shortening it.
 */
export function compatCallOptions(
  options: LanguageModelV4CallOptions,
  reasoningEffort: string | undefined,
  maxOutputTokens?: number,
): LanguageModelV4CallOptions {
  const effort = effortFor(options, reasoningEffort);
  const tools = options.tools?.filter((t) => t.type !== "provider");
  const { providerOptions: _dropped, tools: _tools, ...rest } = options;
  const asked = options.maxOutputTokens;
  return {
    ...rest,
    ...(maxOutputTokens !== undefined && {
      maxOutputTokens: asked === undefined ? maxOutputTokens : Math.min(asked, maxOutputTokens),
    }),
    ...(tools?.length && { tools }),
    ...(effort && { providerOptions: { openaiCompatible: { reasoningEffort: effort } } }),
  };
}

/**
 * A chat model on an OpenAI-compatible API that accepts what the features send to Vertex:
 * audio is transcribed first (the model reads text), Vertex options are mapped or dropped.
 */
export class CompatLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";

  constructor(
    private readonly inner: LanguageModelV4,
    private readonly ep: CompatEndpoint,
  ) {}

  get provider() {
    return this.inner.provider;
  }
  get modelId() {
    return this.inner.modelId;
  }
  get supportedUrls() {
    return this.inner.supportedUrls;
  }

  private async prepare(options: LanguageModelV4CallOptions): Promise<LanguageModelV4CallOptions> {
    const language = languageHint(
      (options.providerOptions as { echo?: { language?: unknown } } | undefined)?.echo?.language,
    );
    const mapped = compatCallOptions(options, this.ep.reasoningEffort, this.ep.maxOutputTokens);
    return {
      ...mapped,
      prompt: await audioToText(this.ep, options.prompt, language, options.abortSignal),
    };
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    return this.inner.doGenerate(await this.prepare(options));
  }

  async doStream(options: LanguageModelV4CallOptions) {
    return this.inner.doStream(await this.prepare(options));
  }
}

/**
 * Vectors of the configured number of dimensions. The size is asked for with `dimensions`,
 * and a longer vector from an endpoint that ignores it is cut here: the model is
 * Matryoshka-trained, so the first values, scaled back to unit length, are the shorter embedding.
 */
export class CompatEmbeddingModel implements EmbeddingModelV4 {
  readonly specificationVersion = "v4";

  constructor(
    private readonly inner: EmbeddingModelV4,
    private readonly dimensions: number,
  ) {}

  get provider() {
    return this.inner.provider;
  }
  get modelId() {
    return this.inner.modelId;
  }
  get maxEmbeddingsPerCall() {
    return this.inner.maxEmbeddingsPerCall;
  }
  get supportsParallelCalls() {
    return this.inner.supportsParallelCalls;
  }

  async doEmbed(options: Parameters<EmbeddingModelV4["doEmbed"]>[0]) {
    const po = options.providerOptions ?? {};
    const result = await this.inner.doEmbed({
      ...options,
      providerOptions: {
        ...po,
        openaiCompatible: { ...po.openaiCompatible, dimensions: this.dimensions },
      },
    });
    return {
      ...result,
      embeddings: result.embeddings.map((v) => {
        if (v.length < this.dimensions)
          throw new Error(
            `embedding has ${v.length} values, fewer than the ${this.dimensions} asked for`,
          );
        if (v.length === this.dimensions) return v;
        const head = v.slice(0, this.dimensions);
        const norm = Math.hypot(...head) || 1;
        return head.map((x) => x / norm);
      }),
    };
  }
}
