import type { Principal } from "@echo/access";
import { UnauthenticatedError } from "@echo/core";
import type { Logger } from "@echo/observability";
import type { Context } from "hono";

/** A signed-in caller as routes see it. */
export interface Signed extends Principal {
  readonly isStaff: boolean;
}

/** Per-request values every route can read; set by the API's middleware. */
export type Env = {
  Variables: { requestId: string; logger: Logger; principal: Signed | null };
};

export type Ctx = Context<Env>;

/** The signed-in caller, or 401 with the body the old API sends. */
export function requireUser(c: Ctx): Signed {
  const p = c.get("principal");
  if (!p) throw new UnauthenticatedError("Invalid session");
  return p;
}
export {
  type Field,
  type Infer,
  type PydanticError,
  type RawRequest,
  rawRequest,
  v,
  validate,
} from "./validate";
