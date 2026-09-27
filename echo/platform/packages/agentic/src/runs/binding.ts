import type { Access } from "@echo/access";
import type { Db } from "@echo/db";
import type { Signed } from "@echo/http";
import type { AgentData, TurnContext } from "../agent/data";

export interface BindingDeps {
  readonly db: Db;
  readonly access: Access;
  readonly enableCanvas: boolean;
}

/**
 * The agent's reads and writes for one turn, bound to the caller and the turn's project and
 * chat. Each method runs the service operation of the matching /api/agentic route with the
 * caller's identity, so the route's access rules apply unchanged.
 */
export function bindAgentData(_deps: BindingDeps, _who: Signed, _ctx: TurnContext): AgentData {
  const missing = (name: string) => () =>
    Promise.reject(new Error(`AgentData.${name} is not wired`));
  return new Proxy({} as AgentData, {
    get: (_t, name) => missing(String(name)),
  });
}
