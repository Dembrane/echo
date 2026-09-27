import type { Config } from "@echo/config";
import type { Logger, Tracer } from "@echo/observability";

/** Everything the HTTP app needs, built whole in main.ts and replaced with fakes in tests. */
export interface Deps {
  readonly config: Config;
  readonly publicConfig: Record<string, unknown>;
  readonly logger: Logger;
  readonly tracer: Tracer;
  /** Resolves when the database answers; readiness fails while it does not. */
  readonly pingDb: () => Promise<unknown>;
}

export type Env = { Variables: { requestId: string; logger: Logger } };
