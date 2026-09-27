import type { Access } from "@echo/access";
import type { Auth, IdentityAccount } from "@echo/auth";
import type { Db } from "@echo/db";
import type { Notifier } from "@echo/notifications";
import type { Logger } from "@echo/observability";
import type { JobDefinition, Payload } from "@echo/queue";
import type { RateLimiter } from "@echo/ratelimit";
import type { ObjectStorage } from "@echo/storage";

/** Enqueues a job; the API's queue is producer-only, the worker runs the handlers. */
export interface Jobs {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: { singletonKey?: string },
  ): Promise<string | null>;
}

/** Everything account and membership routes need, built in the API's main.ts. */
export interface AccountDeps {
  readonly db: Db;
  readonly access: Access;
  readonly auth: Pick<Auth, "api">;
  /** Self-service identity changes (password, TOTP, suspension) on Better Auth's tables. */
  readonly identity: IdentityAccount;
  readonly notifier: Notifier;
  readonly limiter: RateLimiter;
  readonly jobs: Jobs;
  /** Avatars and whitelabel logos. */
  readonly files: ObjectStorage;
  readonly logger?: Logger;
  readonly settings: {
    /** HMAC key of invite links; equals Directus's SECRET until cutover. */
    readonly inviteHashSecret: string;
    /** Dashboard origin, the base of every link in an email. */
    readonly dashboardUrl: string;
    readonly onboardingFollowupInbox: string;
    /** directus_files.storage of new uploads, so Directus keeps serving them. */
    readonly directusStorageLocation: string;
  };
}
