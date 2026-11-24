import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where the policy sent the model calls made inside this scope, for the call log. The llm
 * layer sets it around every routed call; metering reads it when it records the call. It
 * only describes: the decision itself was already taken.
 */
export interface RoutingNote {
  /** The organisation that owns the project's workspace; null when none was found. */
  readonly organisationId: string | null;
  /** The provider the policy resolved to ("scaleway", "google"). */
  readonly provider: string;
  /** Why: "project", "account-default", "environment-default", "conversation", "fail-closed:<cause>". */
  readonly reason: string;
  /** What the organisation allowed at that moment; null when it was not read. */
  readonly allowed: readonly string[] | null;
  /** The conversation the call belongs to, when its payer is one (or its artifact); absent otherwise. */
  readonly conversationId?: string | null;
}

const storage = new AsyncLocalStorage<RoutingNote>();

export function withRouting<T>(note: RoutingNote, fn: () => T): T {
  return storage.run(note, fn);
}

export function routing(): RoutingNote | undefined {
  return storage.getStore();
}
