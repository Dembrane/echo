import type { Pauser, RetryStats, SpanCutter } from "./speech-retry";

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
  /** Cuts a stretch out of this audio so Whisper can read a doubtful part again alone; absent means no retries. */
  readonly cutSpan?: SpanCutter;
  /** The pauses of this audio, for the retry that looks for loud stretches with few words. */
  readonly pauses?: Pauser;
}

export interface TranscribeResult {
  readonly transcript: string;
  readonly note: string;
  /** Which deployment answered each pass, so a fallback-degraded chunk is identifiable. */
  readonly models: readonly (string | null)[];
  /** What the confidence retries did for this audio, when they were on. */
  readonly retry?: RetryStats;
}

/** Typed text in, the same redaction audio gets out. */
export interface RedactTextInput {
  readonly text: string;
  readonly language?: string | null;
  readonly hotwords?: readonly string[] | null;
  readonly usePiiRedaction?: boolean;
  readonly anonymizeTranscripts?: boolean;
  readonly customGuidancePrompt?: string | null;
}

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  /**
   * Redacts text a participant typed: the regex pass when anonymising, then the model pass
   * when either flag is on, exactly the steps a transcript of audio goes through. With both
   * flags off the text comes back unchanged and no model is called.
   */
  redactText(input: RedactTextInput): Promise<TranscribeResult>;
}
