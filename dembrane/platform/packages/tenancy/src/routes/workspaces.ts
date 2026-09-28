import type { Env } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { Hono } from "hono";
import type { TenancyDeps } from "../deps";
import { workspaceService } from "../service/workspaces";
import { helpers } from "./common";
import {
  CreateWorkspace,
  HandoffInitiate,
  PreviewDowngradeQuery,
  SetTier,
  UsageQuery,
} from "./models";

/** /api/v2/workspaces: list, create, delete, tier, usage and partner handoff. */
export function workspaceRoutes(deps: TenancyDeps) {
  const svc = workspaceService(deps);
  const h = helpers(deps);
  return new Hono<Env>()
    .get("/api/v2/workspaces/tier-capacities", (c) => c.json(svc.tierCapacities()))
    .get("/api/v2/workspaces", async (c) => c.json(await svc.list(h.user(c))))
    .post("/api/v2/workspaces", async (c) => {
      const who = h.user(c);
      const { body } = await p.validate(c.req, { body: CreateWorkspace });
      return c.json(await svc.create(who, body.data));
    })
    .delete("/api/v2/workspaces/:workspace_id", async (c) =>
      c.json(await svc.remove(await h.ws(c))),
    )
    .patch("/api/v2/workspaces/:workspace_id/tier", async (c) => {
      const who = h.user(c);
      const { body } = await p.validate(c.req, { body: SetTier });
      return c.json(await svc.setTier(who, c.req.param("workspace_id"), body.data));
    })
    .get("/api/v2/workspaces/:workspace_id/tier/preview-downgrade", async (c) => {
      const ctx = await h.ws(c);
      const { query } = await p.validate(c.req, { query: PreviewDowngradeQuery });
      return c.json(svc.previewDowngrade(ctx, query.to_tier));
    })
    .get("/api/v2/workspaces/:workspace_id/usage", async (c) => {
      const ctx = await h.ws(c);
      const { query } = await p.validate(c.req, { query: UsageQuery });
      return c.json(await svc.usage(ctx, query.month_offset));
    })
    .post("/api/v2/workspaces/:workspace_id/handoff/initiate", async (c) => {
      const ctx = await h.ws(c);
      const { body } = await p.validate(c.req, { body: HandoffInitiate });
      return c.json(await svc.initiateHandoff(ctx, body.data));
    })
    .post("/api/v2/workspaces/:workspace_id/handoff/accept", async (c) =>
      c.json(await svc.acceptHandoff(await h.ws(c))),
    )
    .post("/api/v2/workspaces/:workspace_id/handoff/cancel", async (c) =>
      c.json(await svc.cancelHandoff(await h.ws(c))),
    );
}
