import { syncIdentitiesFromDirectus } from "@echo/auth/sync";
import { connect, grantRuntimeRole, migrate } from "@echo/db";
import { installQueueSchema } from "@echo/queue";

/**
 * The Cloud Run job that runs before every rollout, with the owner login: schema
 * migrations, then the DBOS queue schema, then data rights for the runtime login. A failure
 * stops the deploy before any new revision takes traffic.
 */
const url = process.env.MIGRATION_DATABASE_URL;
const role = process.env.APP_DB_ROLE;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");

const log = (message: string, fields: object = {}) =>
  process.stdout.write(
    `${JSON.stringify({ severity: "INFO", message, service: "echo-migrate", ...fields })}\n`,
  );

const started = performance.now();
const result = await migrate(url);
log("schema migrated", result);
await installQueueSchema(url);
log("queue schema ready");
// Until cutover, users keep being created through Directus; copying them on every deploy
// lets each one sign in to the new stack with the same password or Google account.
const sql = connect(url, { max: 1, onnotice: () => {} });
log("identities synced", await syncIdentitiesFromDirectus(sql));
await sql.end();
if (role) {
  await grantRuntimeRole(url, role, ["public", "dbos"]);
  log("runtime role granted", { role });
}
log("migration job complete", { ms: Math.round(performance.now() - started) });
// A one-shot job ends here. DBOS's scheduler can keep timers alive after shutdown, and a
// job that never exits holds the rollout until Cloud Run's task timeout.
process.exit(0);
