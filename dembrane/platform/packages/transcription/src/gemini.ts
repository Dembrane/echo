import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import {
  FALL_BACK_ON_REFUSAL,
  isRetryable,
  ModelRefusalError,
  type Models,
  speechHint,
} from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import { renderPrompt } from "@dembrane/prompts";
import { TranscriptParseError, TranscriptRefusedError } from "./errors";
import { regexRedactPii } from "./pii";
import { type RetryPolicy, transcribeChecked } from "./speech-retry";
import type {
  RedactTextInput,
  TranscribeInput,
  TranscribeResult,
  Transcriber,
} from "./transcriber";

const SCHEMA = {
  type: "object",
  properties: {
    corrected_transcript: { type: "string" },
    note: { type: "string" },
  },
  required: ["corrected_transcript", "note"],
} as const;

// Filters off did not lower 3.8-flash refusals in replay; the fallback is what recovers them (ECHO-980).
const PROVIDER_OPTIONS = { ...FALL_BACK_ON_REFUSAL, vertex: { threshold: "OFF" } };
// The redaction pass copies a transcript with names masked; reasoning adds time and
// answer tokens and nothing else. Read by the OpenAI-compatible provider only.
const NO_REASONING = { openaiCompatible: { reasoningEffort: "none" } };

// Gemini sometimes emits a literal backslash-u that is not a \uXXXX escape. The
// lookbehind and the even-backslash group keep already-escaped backslashes intact.
const BAD_UNICODE_ESCAPE = /(?<!\\)((?:\\\\)*)\\u(?![0-9a-fA-F]{4})/g;

interface Parsed {
  readonly corrected_transcript: string;
  readonly note: string;
}

/** _parse_transcript_response: the JSON payload, repairing stray escapes when possible. */
export function parseTranscriptJson(content: string, finishReason: string | null): Parsed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (first) {
    const repaired = content.replace(BAD_UNICODE_ESCAPE, "$1\\\\u");
    try {
      parsed = repaired !== content ? JSON.parse(repaired) : null;
    } catch {
      parsed = null;
    }
    if (parsed === null)
      throw new TranscriptParseError(
        `Unparseable transcript JSON (finish_reason=${finishReason}, ${content.length} chars): ${(first as Error).message}`,
        finishReason,
      );
  }
  const p = parsed as Record<string, unknown> | null;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    typeof p.corrected_transcript !== "string" ||
    typeof p.note !== "string"
  )
    throw new TranscriptParseError(
      `Transcript JSON missing ('corrected_transcript', 'note') (finish_reason=${finishReason})`,
      finishReason,
    );
  return { corrected_transcript: p.corrected_transcript, note: p.note };
}

/**
 * The Dembrane-26-07 workflow (transcribe.py): one Gemini pass on multi_modal_pro that
 * transcribes the audio, then, when redaction is asked for, the correction-and-redaction
 * pass on the audio plus that transcript. Rate-limited or failing calls degrade to
 * multi_modal_fast, as the per-call fallback did.
 */
export class GeminiTranscriber implements Transcriber {
  constructor(
    private readonly models: Models,
    private readonly logger: Logger,
    private readonly opts: { retry?: RetryPolicy | null } = {},
  ) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const piiOn = Boolean(input.usePiiRedaction || input.anonymizeTranscripts);
    const hotwordsStr = input.hotwords?.length ? input.hotwords.join(", ") : "";
    if (this.models.speechToText) return this.transcribeWithSpeechModel(input, piiOn, hotwordsStr);
    const prompt =
      input.promptOverride ||
      renderPrompt("transcript_from_audio_workflow", "en", {
        hotwords_str: hotwordsStr,
        pii_redaction: false,
        custom_guidance_prompt: input.customGuidancePrompt ?? null,
        language: input.language ?? null,
      });
    const first = await this.complete(
      [
        { role: "system", content: prompt },
        { role: "user", content: [audioPart(input.audio)] },
      ],
      input.language,
    );
    let transcript = first.json.corrected_transcript;
    let note = first.json.note;
    const models: (string | null)[] = [first.model];

    // Regex runs before correction, matching the old pipeline order.
    if (input.anonymizeTranscripts) transcript = regexRedactPii(transcript);

    // Never pass keyterms: an empty allow-list is load-bearing so all PII (including
    // hotword names) is redacted, not exempted.
    if (piiOn) {
      const correction = renderPrompt("transcript_correction_workflow", "en", {
        hotwords_str: hotwordsStr,
        pii_redaction: true,
        custom_guidance_prompt: input.customGuidancePrompt ?? null,
      });
      const second = await this.complete(
        [
          { role: "system", content: correction },
          {
            role: "user",
            content: [{ type: "text", text: transcript }, audioPart(input.audio)],
          },
        ],
        input.language,
      );
      transcript = second.json.corrected_transcript;
      note = second.json.note;
      models.push(second.model);
    }
    return { transcript: transcript === "" ? "[Nothing to transcribe]" : transcript, note, models };
  }

  /**
   * A provider with a speech-to-text model (Whisper on the OpenAI-compatible provider): its
   * text is the transcript. A chat model asked to rewrite it paraphrases and, with reasoning
   * on, ran out of answer tokens on long chunks. The chat model only does the redaction pass,
   * on text, with reasoning off.
   */
  private async transcribeWithSpeechModel(
    input: TranscribeInput,
    piiOn: boolean,
    hotwordsStr: string,
  ): Promise<TranscribeResult> {
    const stt = this.models.speechToText as NonNullable<Models["speechToText"]>;
    const retrying = Boolean(this.opts.retry && input.cutSpan);
    const checked = retrying
      ? await transcribeChecked(
          stt,
          input.audio,
          {
            language: input.language ?? null,
            ...(hotwordsStr && { prompt: hotwordsStr }),
            priority: input.priority ?? "live",
          },
          undefined,
          input.cutSpan,
          this.opts.retry ?? null,
          undefined,
          input.pauses,
        )
      : null;
    const transcript =
      checked?.result.text ??
      (await stt.transcribe(input.audio, {
        language: input.language ?? null,
        ...(hotwordsStr && { prompt: hotwordsStr }),
        priority: input.priority ?? "live",
      }));
    const redacted = await this.redactText({
      text: transcript,
      language: input.language ?? null,
      usePiiRedaction: piiOn,
      anonymizeTranscripts: input.anonymizeTranscripts ?? false,
      customGuidancePrompt: input.customGuidancePrompt ?? null,
      hotwords: input.hotwords ?? null,
    });
    return {
      transcript: redacted.transcript,
      note: redacted.note,
      models: [stt.model, ...redacted.models],
      ...(checked && { retry: checked.stats }),
    };
  }

  /**
   * The redaction of text alone, shared by the speech-model path and by typed contributions:
   * the regex pass when anonymising, then the model pass with reasoning off. An allow-list
   * of hotwords is never passed, so names are redacted too.
   */
  async redactText(input: RedactTextInput): Promise<TranscribeResult> {
    const piiOn = Boolean(input.usePiiRedaction || input.anonymizeTranscripts);
    const hotwordsStr = input.hotwords?.length ? input.hotwords.join(", ") : "";
    let transcript = input.text;
    let note = "";
    const models: (string | null)[] = [];
    if (input.anonymizeTranscripts) transcript = regexRedactPii(transcript);
    if (piiOn && transcript !== "") {
      const correction = renderPrompt("transcript_correction_workflow", "en", {
        hotwords_str: hotwordsStr,
        pii_redaction: true,
        custom_guidance_prompt: input.customGuidancePrompt ?? null,
      });
      const second = await this.complete(
        [
          { role: "system", content: correction },
          { role: "user", content: [{ type: "text", text: transcript }] },
        ],
        input.language,
        NO_REASONING,
      );
      transcript = second.json.corrected_transcript;
      note = second.json.note;
      models.push(second.model);
    }
    return { transcript: transcript === "" ? "[Nothing to transcribe]" : transcript, note, models };
  }

  /**
   * One call returning the transcript schema, retried once on a bad payload (not on a
   * truncated one: the same audio truncates the same way).
   */
  private async complete(
    prompt: LanguageModelV4Prompt,
    language?: string | null,
    extraOptions: Record<string, Record<string, unknown>> = {},
  ): Promise<{ json: Parsed; model: string | null }> {
    let last: TranscriptParseError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text, finishReason, model } = await this.call(prompt, language, extraOptions);
      this.logger.info({ model }, "transcript call answered");
      try {
        return { json: parseTranscriptJson(text, finishReason), model };
      } catch (err) {
        if (!(err instanceof TranscriptParseError)) throw err;
        last = err;
        this.logger.warn(
          { attempt: attempt + 1, err: err.message },
          "transcript JSON parse failed",
        );
        if (err.isTruncated) break;
      }
    }
    throw last ?? new TranscriptParseError("transcript completion never ran");
  }

  private async call(
    prompt: LanguageModelV4Prompt,
    language: string | null | undefined,
    extraOptions: Record<string, Record<string, unknown>>,
  ) {
    const run = async (m: LanguageModelV4) => {
      let r: LanguageModelV4GenerateResult;
      try {
        r = await m.doGenerate({
          prompt,
          responseFormat: { type: "json", schema: SCHEMA as never },
          providerOptions: {
            ...PROVIDER_OPTIONS,
            ...speechHint(this.models, language),
            ...extraOptions,
          },
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
      return {
        text,
        finishReason: raw ? String(raw).toLowerCase() : null,
        model: r.response?.modelId ?? null,
      };
    };
    try {
      return await run(this.models.model("multi_modal_pro"));
    } catch (err) {
      if (!isRetryable(err)) throw err;
      this.logger.warn(
        { err: (err as Error).message },
        "transcription falls back to multi_modal_fast",
      );
      return run(this.models.model("multi_modal_fast"));
    }
  }
}

function audioPart(audio: Uint8Array) {
  // Labelled audio/mp3 whatever the container, as the Python API sent it.
  return {
    type: "file" as const,
    data: { type: "data" as const, data: audio },
    mediaType: "audio/mp3",
  };
}
