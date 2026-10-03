import type { AccessStore } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import type { JobSink } from "./jobs";
import type { LogoStore } from "./logos";

/** Everything the tenancy namespace needs, built once by the app and replaced by fakes in tests. */
export interface TenancyDeps {
  readonly db: Db;
  /** Reads access decisions from; the Drizzle store in the app, the memory twin in tests. */
  readonly accessStore: AccessStore;
  readonly jobs: JobSink;
  /** Dashboard origin that invite links and email buttons point at. */
  readonly dashboardUrl: string;
  /** Signs invite links; equal to the old API's DIRECTUS_SECRET until old links expire. */
  readonly inviteSecret: string;
  /** Where uploaded logos go. Without it, logo uploads answer 503. */
  readonly logos?: LogoStore;
  readonly now?: () => Date;
  /**
   * Called once a project is created in a workspace: customer accounts mark "Create a
   * project" done. It must never throw; the project exists.
   */
  readonly onProjectCreated?: (projectId: string) => Promise<void>;
}

export function clock(deps: Pick<TenancyDeps, "now">): Date {
  return deps.now ? deps.now() : new Date();
}
