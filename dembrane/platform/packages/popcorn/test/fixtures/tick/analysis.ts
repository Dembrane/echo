import { NO_OBJECTS } from "../../../src/deck";
import type { TickAnalysis } from "../../../src/worker";

/** A session the legacy writer owns: an empty deck store and nothing published. */
export const NO_ANALYSIS: TickAnalysis = {
  deck: {
    deckObjects: async () => NO_OBJECTS,
    excludedObjectIds: async () => new Set(),
    currentDeck: async () => null,
    assembleDeck: async () => null,
    owns: async () => false,
  },
  executor: null,
};
