import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";

/** Connection to an OpenAI-compatible API (Scaleway Generative APIs, for example). */
export interface CompatEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Speech-to-text model behind `/audio/transcriptions`. */
  readonly transcriptionModel: string;
  /** Reasoning effort for calls that do not set their own; unset leaves the model default. */
  readonly reasoningEffort?: string | undefined;
  /** Injected so tests can assert requests without the network. */
  readonly fetch?: typeof fetch | undefined;
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

/** Audio to text on the endpoint's `/audio/transcriptions`. */
export async function transcribeAudio(
  ep: CompatEndpoint,
  audio: Uint8Array,
  language?: string,
): Promise<string> {
  const kind = sniff(audio);
  const form = new FormData();
  form.set("model", ep.transcriptionModel);
  form.set("response_format", "json");
  if (language) form.set("language", language);
  form.set("file", new Blob([audio as never], { type: kind.type }), `audio.${kind.ext}`);
  const res = await (ep.fetch ?? fetch)(`${ep.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${ep.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const err = new Error(`transcription ${res.status}: ${(await res.text()).slice(0, 300)}`);
    // Rate limits and server faults are worth another try; a bad request is not.
    (err as { isRetryable?: boolean }).isRetryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const body = (await res.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
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
          const text = await transcribeAudio(ep, bytes, language);
          return { type: "text", text: `Transcript of the audio: ${text || "(no speech heard)"}` };
        },
      ),
    );
    out.push({ ...message, content: parts } as never);
  }
  return out;
}

/** Vertex thinking budgets mapped to a reasoning effort: 0 is off, a small budget is low. */
function effortFor(options: LanguageModelV4CallOptions, fallback: string | undefined) {
  const po = (options.providerOptions ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const direct = po.openaiCompatible?.reasoningEffort;
  if (typeof direct === "string") return direct;
  const cfg = (po.vertex?.thinkingConfig ?? po.google?.thinkingConfig) as
    | { thinkingBudget?: number }
    | undefined;
  const budget = cfg?.thinkingBudget;
  if (typeof budget === "number") return budget <= 0 ? "none" : "low";
  return fallback;
}

/**
 * What a call looks like to an OpenAI-compatible provider: the Vertex-only provider
 * options and the Google Search tool are dropped, and a thinking budget becomes a
 * reasoning effort. Audio parts are handled separately, by `audioToText`.
 */
export function compatCallOptions(
  options: LanguageModelV4CallOptions,
  reasoningEffort: string | undefined,
): LanguageModelV4CallOptions {
  const effort = effortFor(options, reasoningEffort);
  const tools = options.tools?.filter((t) => t.type !== "provider");
  const { providerOptions: _dropped, tools: _tools, ...rest } = options;
  return {
    ...rest,
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
    const mapped = compatCallOptions(options, this.ep.reasoningEffort);
    return { ...mapped, prompt: await audioToText(this.ep, options.prompt, language) };
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    return this.inner.doGenerate(await this.prepare(options));
  }

  async doStream(options: LanguageModelV4CallOptions) {
    return this.inner.doStream(await this.prepare(options));
  }
}

/** Asks for the configured number of dimensions on every call. */
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

  doEmbed(options: Parameters<EmbeddingModelV4["doEmbed"]>[0]) {
    return this.inner.doEmbed({
      ...options,
      providerOptions: {
        ...options.providerOptions,
        openaiCompatible: { dimensions: this.dimensions },
      },
    });
  }
}
