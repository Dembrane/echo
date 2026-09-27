import type { Access } from "@echo/access";
import type { Models } from "@echo/llm";
import type { Logger } from "@echo/observability";
import type { RateLimiter } from "@echo/ratelimit";
import type { Capture } from "./capture";
import type { ChatReads } from "./conversations";
import type { ChatsStorage } from "./storage";

/** What the chat services use; built once by the routes, faked in tests. */
export interface ChatDeps {
  readonly store: ChatsStorage;
  readonly reads: ChatReads;
  readonly access: Access;
  /** Language models by group; tests pass fakes. */
  readonly models: Pick<Models, "model">;
  readonly limiter: Pick<RateLimiter, "check">;
  readonly capture: Capture;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly newId: () => string;
  /** How long a reply may stay silent before the dashboard is told the system is busy. */
  readonly highLoadDelayMs: number;
  /** Per-process cache of suggestions for fresh chats (Redis in the Python API). */
  readonly suggestionCache: Map<string, { at: number; value: Suggestion[] }>;
}

export interface Suggestion {
  readonly icon: string;
  readonly label: string;
  readonly prompt: string;
}
