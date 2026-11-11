import { registerRecipe } from "../registry";
import { RECIPE as ARGUMENTS } from "./arguments";
import { ASSESSMENT_RECIPE } from "./assessment";
import { RECIPE as DEDUPLICATION } from "./deduplication";
import { RECIPE as INTEGRATION } from "./integration";
import { RECIPE as POPCORN } from "./popcorn";
import { RECIPE as POPCORN_TENSIONS } from "./popcorn-tensions";
import { RECIPE as STAKEHOLDERS } from "./stakeholders";
import { RECIPE as TENSIONS } from "./tensions";

/**
 * The built-in recipes, registered on import. The runs API and the worker import this
 * module, so both know every recipe the other may name.
 */
for (const recipe of [ARGUMENTS, INTEGRATION, ASSESSMENT_RECIPE]) registerRecipe(recipe);
registerRecipe(DEDUPLICATION);
registerRecipe(TENSIONS);
registerRecipe(STAKEHOLDERS);
registerRecipe(POPCORN);
registerRecipe(POPCORN_TENSIONS);

export { ASSESSMENT_RECIPE_ID, recordAssessment } from "./assessment";
export { type PopcornSources, SOURCES_KEY as POPCORN_SOURCES_KEY, sessionSources } from "./popcorn";
export {
  type PopcornTensionSources,
  type SessionTension,
  type SessionTensions,
  SOURCES_KEY as POPCORN_TENSIONS_SOURCES_KEY,
  sessionTensionSources,
} from "./popcorn-tensions";
export {
  countConversationsWithTranscripts,
  defaultProducerServices,
  loadTranscripts,
  PRODUCERS_KEY,
  type ProducerServices,
} from "./services";
