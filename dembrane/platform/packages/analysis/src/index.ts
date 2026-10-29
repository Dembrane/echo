/// <reference path="./text-modules.d.ts" />
import "./recipes";

export { revisionDoc, runDoc } from "./bff";
export * from "./budgets";
export * from "./contracts";
export { clientOf, isUuid, micros, pyIso } from "./db";
export { EmbeddingService, inputHash as embeddingInputHash } from "./embeddings";
export * from "./executor";
export { type AnalysisWorker, analysisSweep, analysisWorker } from "./jobs";
export {
  claimKey,
  MAX_TITLE_CHARS,
  MIN_TITLE_NODES,
  pyFind,
  SelectionTooLarge,
  SelectionTooSmall,
  type Transcript,
  titleLines,
  titleSelectionKey,
} from "./maprecipe";
export * from "./mapview";
export * as popcornShared from "./popcorn-shared";
export {
  ASSESSMENT_RECIPE_ID,
  countConversationsWithTranscripts,
  POPCORN_SOURCES_KEY,
  POPCORN_TENSIONS_SOURCES_KEY,
  type PopcornSources,
  type PopcornTensionSources,
  PRODUCERS_KEY,
  type ProducerServices,
  recordAssessment,
  type SessionTension,
} from "./recipes";
export { dataBlock, jsonFromText } from "./recipes/model";
export {
  type ConversationPhrases,
  phraseRecords,
  RECIPE_ID as POPCORN_RECIPE_ID,
  scopeKeyFor as popcornScopeKey,
} from "./recipes/popcorn";
export {
  RECIPE_ID as POPCORN_TENSIONS_RECIPE_ID,
  SCOPE_KEY as POPCORN_TENSIONS_SCOPE_KEY,
} from "./recipes/popcorn-tensions";
export * from "./registry";
export { type AnalysisRoutesDeps, analysisRoutes } from "./routes";
export * from "./runtime";
export * from "./snapshots";
export { AnalysisStore } from "./store";
export { normalizeText, normKey } from "./text";
export * from "./types";
