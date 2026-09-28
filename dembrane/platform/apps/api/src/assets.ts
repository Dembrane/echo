import { POPCORN_PAGE_ASSETS } from "@dembrane/popcorn";

/**
 * Files the API reads at run time, checked at boot. apps/api/Dockerfile copies the trees
 * these sit in; a file added here without a copy there fails the image's smoke test.
 */
export const API_ASSETS: readonly string[] = POPCORN_PAGE_ASSETS;
