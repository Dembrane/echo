import type { LanguageModelV4, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { isRetryable, type Models } from "@echo/llm";
import type { Logger } from "@echo/observability";
import { renderPrompt } from "@echo/prompts";
import { TranscriptParseError } from "./errors";
import { regexRedactPii } from "./pii";
import type { TranscribeInput, TranscribeResult, Transcriber } from "./transcriber";

const SCHEMA = {
  type: "object",
  properties: {
    corrected_transcript: { type: "string" },
    note: { type: "string" },
  },
  required: ["corrected_transcript", "note"],
} as const;

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
  ) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const piiOn = Boolean(input.usePiiRedaction || input.anonymizeTranscripts);
    const hotwordsStr = input.hotwords?.length ? input.hotwords.join(", ") : "";
    const prompt =
      input.promptOverride ||
      renderPrompt("transcript_from_audio_workflow", "en", {
        hotwords_str: hotwordsStr,
        pii_redaction: false,
        custom_guidance_prompt: input.customGuidancePrompt ?? null,
        language: input.language ?? null,
      });
    const first = await this.complete([
      { role: "system", content: prompt },
      { role: "user", content: [audioPart(input.audio)] },
    ]);
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
      const second = await this.complete([
        { role: "system", content: correction },
        {
          role: "user",
          content: [{ type: "text", text: transcript }, audioPart(input.audio)],
        },
      ]);
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
  ): Promise<{ json: Parsed; model: string | null }> {
    let last: TranscriptParseError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text, finishReason, model } = await this.call(prompt);
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

  private async call(prompt: LanguageModelV4Prompt) {
    const run = async (m: LanguageModelV4) => {
      const r = await m.doGenerate({
        prompt,
        responseFormat: { type: "json", schema: SCHEMA as never },
      });
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
