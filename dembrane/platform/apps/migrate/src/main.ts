import { seedLegalTexts } from "@dembrane/accounts";
import { syncIdentitiesFromDirectus } from "@dembrane/auth/sync";
import { loadSections } from "@dembrane/config";
import { bootAssets } from "@dembrane/core";
import {
  connect,
  createDb,
  dropPreviewDatabase,
  ensurePreviewDatabase,
  grantRuntimeRole,
  MIGRATE_ASSETS,
  migrate,
  withDatabase,
} from "@dembrane/db";
import { installQueueSchema } from "@dembrane/queue";
import { seedDefaultTopics } from "@dembrane/verify/defaults";
import { PREVIEW_SEED_ASSETS, seedPreview } from "./preview-seed";

/**
 * The Cloud Run job that runs before every rollout, with the owner login: schema
 * migrations, then the DBOS queue schema, then data rights for the runtime login. A failure
 * stops the deploy before any new revision takes traffic.
 */
bootAssets("echo-migrate", loadSections(["assets"]).values.assets.root, [
  ...MIGRATE_ASSETS,
  ...PREVIEW_SEED_ASSETS,
]);

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const role = process.env.APP_DB_ROLE;
if (!ownerUrl) throw new Error("MIGRATION_DATABASE_URL is required");
// PR previews: DATABASE_NAME picks the preview's own database on the shared instance.
const databaseName = process.env.DATABASE_NAME;

const log = (message: string, fields: object = {}) =>
  process.stdout.write(
    `${JSON.stringify({ severity: "INFO", message, service: "echo-migrate", ...fields })}\n`,
  );

if (databaseName) {
  // Teardown of a closed PR's preview runs this job once more with the drop switch.
  if (process.env.MIGRATE_DROP_DATABASE === "1") {
    await dropPreviewDatabase(ownerUrl, databaseName);
    log("preview database dropped", { database: databaseName });
    process.exit(0);
  }
  const created = await ensurePreviewDatabase(ownerUrl, databaseName);
  log("preview database ready", { database: databaseName, created });
}
const url = withDatabase(ownerUrl, databaseName);

const started = performance.now();
// Set only where the old stack shares the database (the parity template): contract
// migrations drop tables it still reads, so they wait for cutover.
const holdContract = process.env.MIGRATE_HOLD_CONTRACT === "1";
// Outside local, test and preview, a pending contract migration without a recorded archive
// stops the job here, before anything is applied, and names the archive script to run.
const result = await migrate(url, { holdContract, appEnv: process.env.APP_ENV });
log("schema migrated", { ...result, holdContract });
await installQueueSchema(url);
log("queue schema ready");
// Until cutover, users keep being created through Directus; copying them on every deploy
// lets each one sign in to the new stack with the same password or Google account.
const sql = connect(url, { max: 1, onnotice: () => {} });
log("identities synced", await syncIdentitiesFromDirectus(sql));
await sql.end();
// The first legal texts (terms, SLA, DPA) an offer can pin, for an environment whose daily
// refresh has not reached dembrane.com yet. A kind that has rows is left alone.
const seedDb = createDb({ url, poolMax: 1 });
log("legal texts seeded", { added: await seedLegalTexts(seedDb.db, new Date()) });
// The global verification topics participants pick from, which the Python API seeded at startup.
log("verification topics seeded", await seedDefaultTopics(seedDb.db));
await seedDb.close();
if (role) {
  await grantRuntimeRole(url, role, ["public", "dbos"]);
  log("runtime role granted", { role });
}
// PR previews only (PREVIEW_SEED=1 from .github/scripts/deploy-env.sh): the admin login and the
// sample data. seedPreview refuses anything but a PR preview's own database.
if (process.env.PREVIEW_SEED === "1") {
  const seedStarted = performance.now();
  const seeded = await seedPreview(url, process.env);
  log("preview seeded", { ...seeded, ms: Math.round(performance.now() - seedStarted) });
}
log("migration job complete", { ms: Math.round(performance.now() - started) });
// A one-shot job ends here. DBOS's scheduler can keep timers alive after shutdown, and a
// job that never exits holds the rollout until Cloud Run's task timeout.
process.exit(0);
