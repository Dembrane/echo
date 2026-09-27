import type { Logger } from "@echo/observability";
import type postgres from "postgres";
import { Hub } from "./hub";

const hubs = new WeakMap<postgres.Sql, Promise<Hub>>();

/**
 * The process's one LISTEN hub for a database client, started on first use. Namespaces
 * that stream live events call this instead of holding a Hub in the app's dependencies,
 * so every stream in a process shares one connection.
 */
export function sharedHub(sql: postgres.Sql, logger: Logger): Promise<Hub> {
  let hub = hubs.get(sql);
  if (!hub) {
    const created = new Hub(sql, logger);
    hub = created.start().then(
      () => created,
      (err) => {
        hubs.delete(sql);
        throw err;
      },
    );
    hubs.set(sql, hub);
  }
  return hub;
}
