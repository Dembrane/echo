import type { Access, StaffAudit } from "@dembrane/access";
import type { Jobs } from "@dembrane/account";
import type { Media } from "@dembrane/audio";
import type { Auth, IdentityAccount } from "@dembrane/auth";
import type { Billing } from "@dembrane/billing";
import type { Config } from "@dembrane/config";
import type { Db } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import type { Models } from "@dembrane/llm";
import type { Mailer } from "@dembrane/mail";
import type { Notifier } from "@dembrane/notifications";
import type { Logger, Tracer } from "@dembrane/observability";
import type { Queue, WorkerFreshness } from "@dembrane/queue";
import type { RateLimiter } from "@dembrane/ratelimit";
import type { Hub } from "@dembrane/realtime";
import type { ObjectStorage } from "@dembrane/storage";
import type { Transcriber } from "@dembrane/transcription";
import type { Deliver } from "@dembrane/webhooks";

/** Everything the HTTP app needs, built whole in main.ts and replaced with fakes in tests. */
export interface Deps {
  readonly config: Config;
  readonly publicConfig: Record<string, unknown>;
  readonly logger: Logger;
  readonly tracer: Tracer;
  /** Resolves when the database answers; readiness fails while it does not. */
  readonly pingDb: () => Promise<unknown>;
  /** How recently a worker (of the given release) heartbeat and finished a job; /ready/worker. */
  readonly workerFreshness: (release?: string) => Promise<WorkerFreshness>;
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
  /** Self-service identity changes on Better Auth's tables. */
  readonly identity: IdentityAccount;
  readonly notifier: Notifier;
  readonly limiter: RateLimiter;
  /** Producer side of the queue: the API enqueues, the worker runs. */
  readonly jobs: Jobs;
  /** The object store (the bucket Directus serves from until cutover) for every upload. */
  readonly files: ObjectStorage;
  /** Durable trail of every staff permission use. */
  readonly staffAudit: StaffAudit;
  readonly mailer: Mailer;
  readonly billing: Billing;
  /** The website's pricing token; null closes the site route. */
  readonly siteToken: string | null;
  /** Participant audio, merged audio and split chunks (the Python API's STORAGE_S3 bucket). */
  readonly audio: ObjectStorage;
  /** ffmpeg work the API waits on (merge on read, duration probes). */
  readonly media: Media;
  readonly transcriber: Transcriber;
  /** Live events from Postgres NOTIFY; null where nothing listens (tests). */
  readonly hub: Hub | null;
  /** GETs dembrane.com's legal pages when an offer is pushed; a fake in tests. */
  readonly fetchText?: (url: string) => Promise<string>;
}

export type { Env, Signed };
