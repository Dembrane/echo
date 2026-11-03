import { withPayer } from "@dembrane/observability";
import { runPopcornTick as unscoped } from "../../../src/tick/run";

/** The tick as the worker's TICK_WORKFLOW runs it: billed to its loop. */
export const runPopcornTick: typeof unscoped = (deps, loopId, ...rest) =>
  withPayer({ ref: "popcorn_loop", id: loopId }, () => unscoped(deps, loopId, ...rest));
