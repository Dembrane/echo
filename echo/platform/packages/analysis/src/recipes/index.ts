import { registerRecipe } from "../registry";
import { RECIPE as ARGUMENTS } from "./arguments";
import { ASSESSMENT_RECIPE } from "./assessment";
import { RECIPE as INTEGRATION } from "./integration";

/**
 * The built-in recipes, registered on import. The runs API and the worker import this
 * module, so both know every recipe the other may name.
 */
for (const recipe of [ARGUMENTS, INTEGRATION, ASSESSMENT_RECIPE]) registerRecipe(recipe);

export { ASSESSMENT_RECIPE_ID, recordAssessment } from "./assessment";
export {
  countConversationsWithTranscripts,
  defaultProducerServices,
  loadTranscripts,
  PRODUCERS_KEY,
  type ProducerServices,
} from "./services";
