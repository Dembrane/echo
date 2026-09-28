import { AGENTIC_ASSETS } from "@echo/agentic";
import { POPCORN_TICK_ASSETS } from "@echo/popcorn";

/**
 * Files the worker reads at run time, checked at boot. apps/worker/Dockerfile copies the
 * trees these sit in; a file added here without a copy there fails the image's smoke test.
 */
export const WORKER_ASSETS: readonly string[] = [...POPCORN_TICK_ASSETS, ...AGENTIC_ASSETS];
