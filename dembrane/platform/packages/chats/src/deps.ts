import type { Access } from "@dembrane/access";
import type { Capture } from "@dembrane/analytics";
import type { Models } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import type { ChatReads } from "./conversations";
import type { FreeChats } from "./free";
import type { ChatsStorage } from "./storage";

/** What the chat services use; built once by the routes, faked in tests. */
export interface ChatDeps {
  readonly store: ChatsStorage;
  readonly reads: ChatReads;
  readonly access: Access;
  readonly freeChats: FreeChats;
  /** Language models by group; tests pass fakes. */
  readonly models: Pick<Models, "model">;
  readonly limiter: Pick<RateLimiter, "check">;
  readonly capture: Capture;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly newId: () => string;
  /** How long a reply may stay silent before the dashboard is told the system is busy. */
  readonly highLoadDelayMs: number;
  /** Overrides the suggestions time limit; tests use it to keep a stalled model quick. */
  readonly suggestionTimeoutMs?: number;
  /** Per-process cache of suggestions per chat state (Redis in the Python API). */
  readonly suggestionCache: Map<string, { at: number; value: Suggestion[] }>;
}

export interface Suggestion {
  readonly icon: string;
  readonly label: string;
  readonly prompt: string;
}
