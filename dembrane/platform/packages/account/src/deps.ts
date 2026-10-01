import type { Access } from "@dembrane/access";
import type { Auth, IdentityAccount } from "@dembrane/auth";
import type { Db } from "@dembrane/db";
import type { Notifier } from "@dembrane/notifications";
import type { Logger } from "@dembrane/observability";
import type { JobDefinition, Payload } from "@dembrane/queue";
import type { RateLimiter } from "@dembrane/ratelimit";
import type { ObjectStorage } from "@dembrane/storage";

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
  /**
   * Called once an invite is accepted, with the organisation joined: customer accounts
   * mark "Invite a colleague" done. It must never throw; the accept has committed.
   */
  readonly onInviteAccepted?: (orgId: string) => Promise<void>;
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
