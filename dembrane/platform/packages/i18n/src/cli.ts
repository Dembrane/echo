#!/usr/bin/env bun
/**
 * Finds lingui catalog entries missing in any locale and, when Vertex credentials are
 * present, fills them with the model and records each in the catalog's review ledger
 * (machine-translations.json beside the .po files). Without credentials it
 * reports the missing count and exits 0, so CI stays green on forks and local checkouts.
 *
 *   bun packages/i18n/src/cli.ts                 report only
 *   bun packages/i18n/src/cli.ts --write         fill when credentials exist
 *   bun packages/i18n/src/cli.ts --write --require-credentials   fail without them
 *
 * Catalogs: the frontend's three (main, accounts, error messages) and the platform's own
 * server-rendered texts (packages/i18n/locales). Run `pnpm messages:compile` in the
 * frontend afterwards so the filled texts reach the bundles.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadSections } from "@dembrane/config";
import { createModels, vertexCompleter } from "@dembrane/llm";
import { fillCatalog } from "./fill";

const here = path.dirname(new URL(import.meta.url).pathname);
const platform = path.resolve(here, "../../..");
const frontend = path.resolve(platform, "../frontend");
// Smallest and most user-facing first, so a run cut short has filled what matters most.
const DIRS = [
  path.join(frontend, "src/lib/errors/locales"),
  path.join(platform, "packages/i18n/locales"),
  path.join(frontend, "src/features/accounts/locales"),
  path.join(frontend, "src/locales"),
].filter((d) => existsSync(path.join(d, "en-US.po")));

const write = process.argv.includes("--write");
const requireCredentials = process.argv.includes("--require-credentials");
const out = (s: string) => process.stdout.write(`${s}\n`);

/** Application default credentials: a key file, gcloud's ADC file, or a metadata server. */
function hasCredentials(): boolean {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file) return existsSync(file);
  if (existsSync(path.join(homedir(), ".config/gcloud/application_default_credentials.json")))
    return true;
  return process.env.K_SERVICE !== undefined || process.env.GCE_METADATA_HOST !== undefined;
}

let completer = null;
if (write && hasCredentials()) {
  const { values } = loadSections(["llm"]);
  const models = createModels({
    vertexProject: values.llm.vertexProject,
    vertexLocation: values.llm.vertexLocation,
    groups: {
      text_fast: values.llm.textFast,
      multi_modal_fast: values.llm.multiModalFast,
      multi_modal_pro: values.llm.multiModalPro,
    },
    embeddingModel: values.llm.embeddingModel,
    embeddingLocation: values.llm.embeddingLocation,
    embeddingDimensions: values.llm.embeddingDimensions,
  });
  completer = vertexCompleter(models, {
    groups: {
      text_fast: values.llm.textFast,
      multi_modal_fast: values.llm.multiModalFast,
      multi_modal_pro: values.llm.multiModalPro,
    },
  });
  out(
    `filling with ${values.llm.textFast[0]} (${values.llm.vertexProject}, ${values.llm.vertexLocation})`,
  );
} else if (write) {
  const note = "no Vertex credentials: reporting only";
  if (requireCredentials) {
    process.stderr.write(`${note}\n`);
    process.exit(1);
  }
  out(note);
}

let missing = 0;
let filled = 0;
let rejected = 0;
let unreviewed = 0;
for (const dir of DIRS) {
  const reports = await fillCatalog(dir, completer, out);
  for (const r of reports) {
    missing += r.missing;
    filled += r.filled;
    rejected += r.rejected;
    unreviewed += r.unreviewed;
    if (r.missing)
      out(
        `${path.relative(path.resolve(platform, ".."), r.file)}: ${r.missing} missing${completer ? `, ${r.filled} filled${r.rejected ? `, ${r.rejected} rejected` : ""}` : ""}`,
      );
  }
}
out(
  completer
    ? `${filled} of ${missing} missing entries filled${rejected ? `; ${rejected} answers dropped for changed placeholders or an em dash` : ""}`
    : `${missing} entries missing a translation`,
);
out(
  `${unreviewed} machine translations waiting for review (machine-translations.json per catalog)`,
);
