import { peerAddress, resolveClientIp } from "@dembrane/http";
import type { MiddlewareHandler } from "hono";
import type { Deps, Env } from "../deps";

/**
 * Resolves the caller's address once, with this environment's proxies, so every rate limit
 * and record in a request agrees on it.
 */
export function clientAddress(deps: Deps): MiddlewareHandler<Env> {
  const opts = {
    trustedProxies: deps.config.http.trustedProxies,
    proxySecret: deps.config.http.proxySecret,
  };
  return async (c, next) => {
    const ip = resolveClientIp(c.req.raw.headers, peerAddress(c), opts);
    c.set("clientIp", ip);
    // The chain as it arrived, to check a new proxy setup against what it resolves to.
    c.get("logger").debug(
      { clientIp: ip, forwardedFor: c.req.header("x-forwarded-for") ?? null },
      "client address",
    );
    await next();
  };
}
