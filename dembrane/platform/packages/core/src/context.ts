/**
 * Who is acting, passed explicitly as the first argument of every service operation.
 * Built once per request by the access middleware (or per job by the worker) and never
 * read from ambient state.
 */
export type Actor =
  | { readonly kind: "user"; readonly userId: string; readonly isAdmin: boolean }
  | { readonly kind: "participant"; readonly projectId: string; readonly conversationId?: string }
  | {
      readonly kind: "agent";
      readonly userId: string;
      readonly grantId: string;
      readonly scopes: readonly string[];
    }
  | { readonly kind: "system"; readonly job: string }
  | { readonly kind: "anonymous" };

export interface OperationContext {
  readonly requestId: string;
  readonly actor: Actor;
  /** Frozen at the start of the operation so one operation sees one "now". */
  readonly now: Date;
}

export function userId(ctx: OperationContext): string | undefined {
  return ctx.actor.kind === "user" || ctx.actor.kind === "agent" ? ctx.actor.userId : undefined;
}
