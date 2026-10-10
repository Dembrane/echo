import { type AnalysisRuntime, type Ceilings, clientOf, type JobSink } from "@dembrane/analysis";
import type { Db } from "@dembrane/db";
import { MapStore } from "@dembrane/map";
import type { Logger } from "@dembrane/observability";
import {
  type Adoption,
  type DeckAnalysis,
  type PopcornFlags,
  popcornDeps,
  queueDispatch,
} from "@dembrane/popcorn";
import { PostgresRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { analysisMapStore } from "./map";
import { adoptResults } from "./service";

export interface AdoptionDeps {
  readonly rt: AnalysisRuntime;
  readonly deck: DeckAnalysis;
  readonly jobs: JobSink;
  readonly db: Db;
  readonly logger: Logger;
  readonly flags: PopcornFlags;
  readonly participantBaseUrl: string;
  readonly adminBaseUrl: string;
  readonly ceilings: Ceilings;
}

/**
 * The adoption a popcorn read ends with (ticks.py calling adopt_results): the presentation
 * takes the first deck, saved run and map it can show and keeps a binding the host already
 * chose, or while the session is live takes the newest of each. The read also asks for the map. Composed in the worker, since the
 * tick lives in @dembrane/popcorn and adoption reads the map through Present.
 */
export function presentAdoption(o: AdoptionDeps): Adoption {
  const d = popcornDeps({
    db: o.db,
    deck: o.deck,
    flags: o.flags,
    participantBaseUrl: o.participantBaseUrl,
    adminBaseUrl: o.adminBaseUrl,
    showFlow: false,
    dispatchTick: queueDispatch(o.jobs),
    limiter: new RateLimiter(new PostgresRateCounter(o.db)),
    logger: o.logger,
  });
  const map = analysisMapStore(o.rt, new MapStore(clientOf(o.db)), o.ceilings);
  return {
    adopt: (report, projectId, newest) => adoptResults(d, map, report, projectId, !newest),
    requestMap: (projectId, actorId) => map.requestGeneration(projectId, actorId),
  };
}
