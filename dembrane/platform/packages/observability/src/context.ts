import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Correlation carried through one request or one job, so every log line and span can be
 * joined back to what caused it. This is the only AsyncLocalStorage in the codebase:
 * business code receives identity and tenancy as arguments, never from here.
 */
export interface Correlation {
  readonly requestId: string;
  readonly traceId?: string;
  readonly spanId?: string;
  /** The request that enqueued the job this work belongs to. */
  readonly causedByRequestId?: string;
  /**
   * The route ("POST /api/v2/bff/chats/:chat_id/reply") or job ("conversations.chunk")
   * this work runs under, so metering can file a model call under the feature that made it
   * without every call site naming itself.
   */
  readonly operation?: string;
}

const storage = new AsyncLocalStorage<Correlation>();

export function withCorrelation<T>(c: Correlation, fn: () => T): T {
  return storage.run(c, fn);
}

export function correlation(): Correlation | undefined {
  return storage.getStore();
}
