import { drizzle } from "drizzle-orm/postgres-js";
import { connect } from "./connection";
import * as schema from "./schema";
import * as relations from "./schema/relations";

export { connect } from "./connection";
export {
  dropPreviewDatabase,
  ensurePreviewDatabase,
  PREVIEW_DATABASE,
  withDatabase,
} from "./database-name";
export {
  ARCHIVE_EXEMPT_ENVS,
  ARCHIVE_SCRIPT,
  ContractArchiveMissing,
  grantRuntimeRole,
  MIGRATE_ASSETS,
  type MigrateOptions,
  type MigrateResult,
  migrate,
  recordContractArchive,
} from "./migrate";
export { schema };
export type Db = ReturnType<typeof createDb>["db"];

export interface DbOptions {
  readonly url: string;
  readonly poolMax: number;
  /** Server-side cap so one bad query cannot hold a connection forever. */
  readonly statementTimeoutMs?: number;
}

export function createDb(opts: DbOptions) {
  const client = connect(opts.url, {
    max: opts.poolMax,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // safe behind a transaction-mode pooler
    connection: { statement_timeout: opts.statementTimeoutMs ?? 30_000, application_name: "echo" },
  });
  const db = drizzle(client, { schema: { ...schema, ...relations } });
  return { db, close: () => client.end({ timeout: 5 }), ping: () => client`select 1` };
}
