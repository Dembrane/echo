export {
  isRecoverableTranscriptionError,
  isVertexInvalidArgument,
  TranscriptionError,
  TranscriptParseError,
  TranscriptRefusedError,
  transcriptionFailureReason,
} from "./errors";
export { FakeTranscriber } from "./fake";
export {
  type FinalInput,
  type FinalPiece,
  type FinalProvider,
  type FinalTranscriber,
  type FinalUsage,
  GEMINI_LIMITS,
  GeminiFinal,
  parseSegments,
  rescaleToPiece,
  type Sentence,
  segmentsPrompt,
  splitLong,
  type TimeFormat,
  tidy,
  toSeconds,
  WHISPER_LIMITS,
  WhisperFinal,
} from "./final";
export {
  applyProposals,
  charDistance,
  type EditInput,
  type EditStats,
  editSentences,
  type GuardResult,
  guardEdit,
  maxWordDistance,
  type Proposals,
  proposeEdits,
} from "./final-edit";
export { GeminiTranscriber, parseTranscriptJson } from "./gemini";
export { regexRedactPii } from "./pii";
export {
  ANSWER_SECONDS_PER_AUDIO_SECOND,
  BYTES_MARGIN,
  FINAL_PIECE_SECONDS,
  GEMINI_MAX_BYTES,
  pieceSeconds,
  REQUEST_TIMEOUT_SECONDS,
  type RequestLimits,
  requestLimits,
  SCALEWAY_MAX_BYTES,
  SCALEWAY_QUOTA_SECONDS,
  type SpeechProvider,
  TIMEOUT_SHARE,
} from "./request-limits";
export {
  better,
  DEFAULT_RETRY,
  doubtful,
  isoOf,
  lowWordSpans,
  NO_RETRIES,
  type Pauser,
  quality,
  type RetryPolicy,
  type RetryStats,
  type Span,
  type SpanCutter,
  spansOf,
  transcribeChecked,
} from "./speech-retry";
export type {
  RedactTextInput,
  TimedText,
  TranscribeInput,
  TranscribeResult,
  Transcriber,
} from "./transcriber";
