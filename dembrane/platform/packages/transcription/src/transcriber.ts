/** One audio file in, its transcript out. The Gemini pipeline and a fake implement it. */
export interface TranscribeInput {
  /** The audio bytes; sent inline, as the Python API did. */
  readonly audio: Uint8Array;
  readonly language?: string | null;
  readonly hotwords?: readonly string[] | null;
  readonly usePiiRedaction?: boolean;
  readonly anonymizeTranscripts?: boolean;
  readonly customGuidancePrompt?: string | null;
  /** Replaces the first pass's prompt; the redaction pass keeps its own. */
  readonly promptOverride?: string | null;
}

export interface TranscribeResult {
  readonly transcript: string;
  readonly note: string;
  /** Which deployment answered each pass, so a fallback-degraded chunk is identifiable. */
  readonly models: readonly (string | null)[];
}

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}
