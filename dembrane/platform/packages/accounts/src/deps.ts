import type { Access, StaffAudit } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import type { ObjectStorage } from "@dembrane/storage";
import type { AccountsJobs } from "./sink";

/** A Drizzle transaction handle; storage functions accept it or the pool. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Conn = Db | Tx;

/** dembrane's own details: the offer letterhead and the bank transfer block of invoices. */
export interface Company {
  readonly name: string;
  readonly address: string;
  readonly vat: string;
  readonly kvk: string;
  readonly iban: string;
  readonly bic: string;
  readonly accountName: string;
}

export interface AccountsSettings {
  readonly dashboardUrl: string;
  readonly company: Company;
  /** Account events are posted for sam (ACCOUNTS_EVENTS_URL set). */
  readonly eventsEnabled: boolean;
  /** Signatures, billing details and questions reach Slack (ACCOUNTS_SLACK_WEBHOOK_URL set). */
  readonly slackEnabled: boolean;
  /**
   * Account events go to sam's inbox (SAM_INBOX_URL set) instead of ACCOUNTS_EVENTS_URL,
   * and sam posts their Slack line, so echo does not.
   */
  readonly samInbox: boolean;
  readonly reminderIntervalDays: number;
  /** Signs invite links like every other invite (account.inviteHashSecret). */
  readonly inviteSecret: string;
  /** Demos made in echo: where they are seeded and which hosts are refused. */
  readonly demo?: {
    readonly portalUrl: string;
    readonly apiUrl: string;
    readonly ownUrls: readonly string[];
    readonly workspaceId: string | null;
    /** Where a demo's QR leads (the build reads it; the API does not). */
    readonly feedbackUrl?: string;
  };
}

/** Everything the accounts operations need; built once in the API, replaced in tests. */
export interface AccountsDeps {
  readonly db: Db;
  readonly access: Access;
  readonly staffAudit: StaffAudit;
  /** Enqueues jobs in the caller's transaction, so a job exists only if its cause committed. */
  readonly jobs: AccountsJobs;
  /** Signed PDFs, uploaded invoices and task files. */
  readonly files: ObjectStorage;
  readonly logger: Logger;
  readonly limiter: RateLimiter;
  readonly now: () => Date;
  readonly settings: AccountsSettings;
  /** GETs a legal page; a fake in tests. */
  readonly fetchText: (url: string) => Promise<string>;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** A plain fetch with a timeout, for the legal pages. */
export async function httpFetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return res.text();
}
