import type { Access, Principal } from "@echo/access";
import type { Auth } from "@echo/auth";
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
  readonly auth: Pick<Auth, "handler" | "api">;
  /** Maps a signed-in user to the ids memberships use; null when the user has no app_user row. */
  readonly principalFor: (userId: string) => Promise<Signed | null>;
  readonly access: Access;
}

export interface Signed extends Principal {
  readonly isStaff: boolean;
}

export type Env = {
  Variables: { requestId: string; logger: Logger; principal: Signed | null };
};
