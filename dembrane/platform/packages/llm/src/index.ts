export {
  CompatEmbeddingModel,
  type CompatEndpoint,
  CompatLanguageModel,
  compatCallOptions,
  echoOptions,
  languageHint,
  type SpeechResult,
  type SpeechSegment,
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
  completerConfigOf,
  embedderConfigOf,
  embeddingLocationOf,
  embeddingModelOf,
  groupsOf,
  type LlmSettings,
  modelsConfigOf,
  searchGroundingOn,
} from "./settings";
export {
  LANGUAGE_NAMES,
  TRANSLATION_SCHEMA,
  type TranslateOptions,
  translateTexts,
} from "./translate";
