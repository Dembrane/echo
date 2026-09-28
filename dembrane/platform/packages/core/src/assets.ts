import { statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Files a package reads at run time (templates, prompts, static pages, the product docs).
 *
 * From source they sit in the package's own folder. The api, worker and migrate images are
 * single binaries built with `bun build --compile`, whose modules live in `/$bunfs` with no
 * files beside them, so a path built from `import.meta.dir` finds nothing there. In a binary
 * every asset resolves under one root instead (ASSETS_ROOT, /app/assets in the images),
 * which the Dockerfiles fill with the same `<package>/...` layout. `docs` is the one
 * optional entry: the repository's docs/ from source, absent in the images.
 *
 * This is the only module that may locate a file relative to its own source; the guard in
 * packages/core/test/assets.test.ts fails any other package that does.
 */

const HERE = import.meta.dir;
/** Linux and macOS binaries run from /$bunfs, Windows ones from B:\~BUN. */
const COMPILED = HERE.startsWith("/$bunfs") || HERE.includes("~BUN");
/** packages/core/src -> packages/ */
const PACKAGES = resolve(HERE, "..", "..");
/** packages/core/src -> the repository's docs/ (dembrane/platform/packages/core/src). */
const REPO_DOCS = resolve(HERE, "..", "..", "..", "..", "..", "docs");

let root: string | null = null;

/** True inside a `bun build --compile` binary. */
export function isCompiled(): boolean {
  return COMPILED;
}

/**
 * Sets where a compiled binary finds its assets. Each app calls it first thing at boot with
 * config.assets.root; from source it has no effect, so tests and local runs never need it.
 */
export function configureAssets(assetsRoot: string): void {
  root = assetsRoot;
}

/**
 * The path of a file `pkg` ships: `assetPath("popcorn", "static", "index.html")`, or
 * `assetPath("docs", "features", "chat.md")` for the repository's docs. Call it when the
 * file is read, not at module load: a binary evaluates every module before its main body
 * configures the root, so a module-level call throws there.
 */
export function assetPath(pkg: string, ...parts: string[]): string {
  if (COMPILED) {
    if (root === null)
      throw new Error(`asset ${[pkg, ...parts].join("/")} read before configureAssets()`);
    return join(root, pkg, ...parts);
  }
  return pkg === "docs" ? join(REPO_DOCS, ...parts) : join(PACKAGES, pkg, ...parts);
}

/**
 * The required assets that are not there, each as `<pkg>/<path>` (a file, or a folder
 * when the loader walks it). An app checks its declared list at boot and exits on any, so
 * a broken image fails its container smoke test and never takes traffic.
 */
export function missingAssets(required: readonly string[]): string[] {
  return required.filter((entry) => {
    const [pkg = "", ...parts] = entry.split("/");
    try {
      statSync(assetPath(pkg, ...parts));
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * The boot check every app runs before it serves or works: configures the root, then exits
 * non-zero naming each missing asset, so Cloud Run keeps the previous revision and CI's
 * container smoke test fails. With `--check-assets` the process exits 0 after a passing
 * check, which lets CI prove an image that needs a database to start. Logs are written by
 * hand because this runs before configuration and the logger exist.
 */
export function bootAssets(service: string, assetsRoot: string, required: readonly string[]): void {
  configureAssets(assetsRoot);
  const missing = missingAssets(required);
  const line = (severity: string, message: string, fields: object) =>
    process.stdout.write(`${JSON.stringify({ severity, message, service, ...fields })}\n`);
  if (missing.length > 0) {
    line("ERROR", "assets missing: the image does not carry files this binary reads", {
      root: COMPILED ? assetsRoot : "source tree",
      missing,
    });
    process.exit(1);
  }
  if (process.argv.includes("--check-assets")) {
    line("INFO", "assets ok", { checked: required.length });
    process.exit(0);
  }
}
