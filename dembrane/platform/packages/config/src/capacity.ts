/**
 * The Postgres connection budget. Every environment must satisfy
 *
 *   environments × (API max instances × per-API + worker instances × per-worker + migrate)
 *     + reserved + headroom ≤ max_connections
 *
 * The instance counts and max_connections come from dembrane/infra/<env>.tfvars.json, the pool sizes
 * from the environment file; test/capacity.test.ts checks every environment, so raising
 * max instances or a pool without room on the server fails CI instead of the database.
 * Transaction-mode poolers (PgBouncer, Cloud SQL managed pooling) are not an option: DBOS
 * and the live-stream hub LISTEN, and presence holds session advisory locks.
 */

/** Connections a process opens outside DATABASE_POOL_MAX and DATABASE_QUEUE_POOL_MAX. */
export const FIXED_CONNECTIONS = {
  /** API: DBOS client that only enqueues (apps/api/src/main.ts). */
  apiQueueClient: 2,
  /** API: the LISTEN connection feeding live streams (apps/api/src/main.ts). */
  apiListener: 1,
  /** API: the connection presence advisory locks live on (packages/agentic/src/runs/live.ts). */
  apiPresence: 1,
  /** Worker: DBOS client for jobs that enqueue other jobs (packages/queue). */
  workerQueueClient: 2,
  /** Worker: executor heartbeat and dead-worker sweep (packages/queue/src/recovery.ts). */
  workerHeartbeat: 2,
  /** Migration job, one per rollout: its largest pool is DBOS's schema install. */
  migrate: 3,
  /** Cloud SQL keeps these for its own superuser (superuser_reserved_connections). */
  reserved: 3,
} as const;

export interface Pools {
  readonly poolMax: number;
  readonly queuePoolMax: number;
}

export interface Scale {
  /** Deployments sharing the instance: the preview instance holds the branch and PR previews. */
  readonly environments: number;
  readonly apiMaxInstances: number;
  readonly workerInstances: number;
  readonly maxConnections: number;
}

export const perApi = (p: Pools) =>
  p.poolMax +
  FIXED_CONNECTIONS.apiQueueClient +
  FIXED_CONNECTIONS.apiListener +
  FIXED_CONNECTIONS.apiPresence;

export const perWorker = (p: Pools) =>
  p.poolMax +
  p.queuePoolMax +
  FIXED_CONNECTIONS.workerQueueClient +
  FIXED_CONNECTIONS.workerHeartbeat;

/** Room kept for rollouts (old revisions draining), a psql session and one-off scripts. */
export const headroom = (maxConnections: number) => Math.max(5, Math.ceil(maxConnections * 0.1));

export function connectionBudget(s: Scale, p: Pools) {
  const perEnvironment =
    s.apiMaxInstances * perApi(p) + s.workerInstances * perWorker(p) + FIXED_CONNECTIONS.migrate;
  const needed =
    s.environments * perEnvironment + FIXED_CONNECTIONS.reserved + headroom(s.maxConnections);
  return { perEnvironment, needed, fits: needed <= s.maxConnections };
}
