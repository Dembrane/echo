export {
  CompatEmbeddingModel,
  type CompatEndpoint,
  CompatLanguageModel,
  compatCallOptions,
  echoOptions,
  languageHint,
  type SpeechRequestLog,
  type SpeechResult,
  type SpeechSegment,
  TRANSCRIBE_TIMEOUT_MS,
  transcribeAudio,
  transcribeSegments,
} from "./compat";
export {
  type Completer,
  type Completion,
  type CompletionRequest,
  compatName,
  completeWith,
  type Embedder,
  GroundingUnavailableError,
  vertexCompleter,
  vertexEmbedder,
  vertexName,
} from "./complete";
export { type FakeAnswer, FakeCompleter, FakeEmbedder } from "./fake";
export {
  type Deployment,
  FALL_BACK_ON_REFUSAL,
  FallbackModel,
  type FallbackOptions,
  isRetryable,
  ModelRefusalError,
} from "./fallback";
export {
  createModels,
  type ModelGroup,
  type Models,
  type ModelsConfig,
  type OpenAICompatibleConfig,
  speechHint,
} from "./models";
export {
  errorLabel,
  type ModelCall,
  type ModelCallObserver,
  observeSafely,
  resetObserverFaults,
} from "./observe";
export {
  checkProfileModels,
  compatibleModelsOf,
  improves,
  PROFILE_NAMES,
  PROFILES,
  type ProfileName,
  profileGaps,
  profileOf,
  type TranscriptionProfile,
} from "./profiles";
export {
  completerConfigOf,
  embedderConfigOf,
  embeddingLocationOf,
  embeddingModelOf,
  groupsOf,
  type LlmSettings,
  modelsConfigOf,
  searchGroundingOn,
} from "./settings";
export { retryAfterMs, SpeechGate, type SpeechPriority } from "./speech-gate";
export {
  LANGUAGE_NAMES,
  TRANSLATION_SCHEMA,
  type TranslateOptions,
  translateTexts,
  withoutClosingFence,
} from "./translate";
