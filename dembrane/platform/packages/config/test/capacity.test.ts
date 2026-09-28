import { expect, test } from "bun:test";
import { connectionBudget, loadConfig, schema } from "../src";
import { walk } from "../src/define";

// Reads the same tfvars the deploy workflow scales from, and the pools each environment
// file sets, so a change to either that overflows max_connections fails here.
const secrets = Object.fromEntries(
  [...walk(schema)]
    .filter(([, k]) => k.meta.secret)
    .map(([, k]) => [
      k.meta.env,
      k.meta.env.endsWith("_URL") ? "postgres://u@h/d" : "s".repeat(48),
    ]),
);

interface Tfvars {
  readonly db_max_connections: number;
  readonly db_environments?: number;
  readonly services: Record<string, { readonly min: number; readonly max: number }>;
}

for (const env of ["preview", "next", "prod"] as const) {
  test(`${env} fits its connection budget`, async () => {
    const tf: Tfvars = await Bun.file(
      new URL(`../../../infra/${env}.tfvars.json`, import.meta.url),
    ).json();
    const { values } = loadConfig({ APP_ENV: env, ...secrets });
    const api = tf.services.api;
    const worker = tf.services.worker;
    if (!api || !worker) throw new Error(`${env}.tfvars.json lacks the api or worker service`);
    const budget = connectionBudget(
      {
        environments: tf.db_environments ?? 1,
        apiMaxInstances: api.max,
        workerInstances: worker.max,
        maxConnections: tf.db_max_connections,
      },
      values.database,
    );
    if (!budget.fits) {
      throw new Error(
        `${env} needs ${budget.needed} connections, max_connections is ${tf.db_max_connections}`,
      );
    }
    expect(budget.fits).toBe(true);
  });
}
