import { type AnalysisRuntime, type Ceilings, clientOf, type JobSink } from "@echo/analysis";
import type { Db } from "@echo/db";
import { MapStore } from "@echo/map";
import type { Logger } from "@echo/observability";
import {
  type Adoption,
  type DeckAnalysis,
  type PopcornFlags,
  popcornDeps,
  queueDispatch,
} from "@echo/popcorn";
import { PostgresRateCounter, RateLimiter } from "@echo/ratelimit";
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
 * The adoption a popcorn read ends with (ticks.py calling adopt_results with
 * initial_only): the presentation takes the first deck, saved run and map it can show,
 * and never replaces a binding the host already chose. Composed in the worker, since the
 * tick lives in @echo/popcorn and adoption reads the map through Present.
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
  return (report, projectId) => adoptResults(d, map, report, projectId, true);
}
