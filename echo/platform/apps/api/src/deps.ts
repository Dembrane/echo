import type { Access } from "@echo/access";
import type { Jobs } from "@echo/account";
import type { Auth, IdentityAccount } from "@echo/auth";
import type { Config } from "@echo/config";
import type { Db } from "@echo/db";
import type { Env, Signed } from "@echo/http";
import type { Notifier } from "@echo/notifications";
import type { Logger, Tracer } from "@echo/observability";
import type { RateLimiter } from "@echo/ratelimit";
import type { ObjectStorage } from "@echo/storage";

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
  /** Self-service identity changes on Better Auth's tables. */
  readonly identity: IdentityAccount;
  readonly notifier: Notifier;
  readonly limiter: RateLimiter;
  /** Producer side of the queue: the API enqueues, the worker runs. */
  readonly jobs: Jobs;
  /** Uploaded files (avatars, logos) in the bucket Directus serves from until cutover. */
  readonly files: ObjectStorage;
}

export type { Env, Signed };
