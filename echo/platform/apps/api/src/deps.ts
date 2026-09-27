import type { Access } from "@echo/access";
import type { Auth } from "@echo/auth";
import type { Config } from "@echo/config";
import type { Db } from "@echo/db";
import type { Env, Signed } from "@echo/http";
import type { Models } from "@echo/llm";
import type { Logger, Tracer } from "@echo/observability";
import type { Queue } from "@echo/queue";
import type { Deliver } from "@echo/webhooks";

/** Everything the HTTP app needs, built whole in main.ts and replaced with fakes in tests. */
export interface Deps {
  readonly config: Config;
  readonly publicConfig: Record<string, unknown>;
  readonly logger: Logger;
  readonly tracer: Tracer;
  /** Resolves when the database answers; readiness fails while it does not. */
  readonly pingDb: () => Promise<unknown>;
  readonly auth: Pick<Auth, "handler" | "api">;
  /** Maps a signed-in user to the ids memberships use; null when the user has no app_user row. */
  readonly principalFor: (userId: string) => Promise<Signed | null>;
  readonly access: Access;
  readonly db: Db;
  readonly models: Models;
  /** Enqueues jobs; pass a transaction in the options so a job commits with its cause. */
  readonly queue: Pick<Queue, "enqueue">;
  /** Sends outbound webhooks for the test button; a fake in tests. */
  readonly deliverWebhook: Deliver;
}

export type { Env, Signed };
