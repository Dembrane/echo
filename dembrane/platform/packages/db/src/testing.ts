import { createDb } from "./index";

export interface Statement {
  readonly q: string;
  readonly params: readonly unknown[];
}

// For tests: a Db that logs every statement it sends; relies on postgres-js calling options.debug per statement.
export function countingDb(url: string, poolMax = 2) {
  const made = createDb({ url, poolMax });
  const log: Statement[] = [];
  const debug = (_: number, q: string, params: readonly unknown[]) => {
    // Leaves out the driver's own type lookup on a new connection.
    if (!q.includes("pg_catalog.pg_type")) log.push({ q, params });
  };
  Object.assign(made.client.options, { debug });
  return { ...made, log };
}
