/**
 * The popcorn pieces the live tick (@dembrane/popcorn) shares with the popcorn, stakeholders
 * and tensions recipes, as ticks.py and the recipes share dembrane/popcorn. A change here
 * changes both, and the recipes hash these prompts and schemas into their step keys, so a
 * change is a new recipe version as well as a new tick.
 */
export {
  buildCorpus,
  components,
  MAX_ANALYSIS_CHARS,
  MAX_ASPECTS,
  MAX_QUOTES,
  MAX_RELATIONS,
  MAX_STAKEHOLDERS,
  STAKEHOLDERS_SCHEMA,
  transcriptMessage,
} from "./recipes/popcorn-shared";
export {
  CALL_TIMEOUT_MS,
  DEDUPE_SCHEMA,
  DEDUPE_SYSTEM,
  HANDED_SCHEMA,
  KNOT_WORDS,
  MAX_POSITIONS_TOTAL,
  MAX_QUOTES_PER_TENSION,
  MAX_TENSIONS,
  MIN_ZERO_SUM,
  POLE_MIN_WORDS,
  POLE_WORDS,
  QUESTION_WORDS,
  trimPositions,
  W,
  WB_END,
  WB_START,
  WRITE_SCHEMA as TENSION_WRITE_SCHEMA,
} from "./recipes/tensions-stages";
