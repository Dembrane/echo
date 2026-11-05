import { AsyncLocalStorage } from "node:async_hooks";

export type PayerRefKind =
  | "project"
  | "conversation"
  | "chat"
  | "agent_run"
  | "report"
  | "canvas"
  | "verify_artifact"
  | "popcorn_loop"
  | "analysis_run"
  | "workspace";

/** Who an AI call is billed to, for metering only, never for access control. */
export type Payer =
  | { readonly ref: PayerRefKind; readonly id: string }
  | { readonly internal: string };

const storage = new AsyncLocalStorage<Payer>();

export function withPayer<T>(p: Payer, fn: () => T): T {
  return storage.run(p, fn);
}

export function payer(): Payer | undefined {
  return storage.getStore();
}

export function payerKey(p: Payer): string {
  return "ref" in p ? `${p.ref}:${p.id}` : `internal:${p.internal}`;
}
