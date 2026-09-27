import type { Env } from "@echo/http";
import { p } from "@echo/legacy-shape";
import { Hono } from "hono";
import type { TenancyDeps } from "../deps";
import { accessRequestService } from "../service/access-requests";
import { sharingService } from "../service/sharing";
import { supportAccessService } from "../service/support-access";
import { helpers } from "./common";
import { AddShare, SupportEventsQuery } from "./models";

/** Joining and requesting workspaces, staff support access, and private project shares. */
export function accessRoutes(deps: TenancyDeps) {
  const requests = accessRequestService(deps);
  const support = supportAccessService(deps);
  const sharing = sharingService(deps);
  const h = helpers(deps);
  const ws = "/api/v2/workspaces/:workspace_id";
  return new Hono<Env>()
    .get("/api/v2/orgs/:org_id/discoverable-workspaces", async (c) =>
      c.json(await requests.discoverable(h.user(c), c.req.param("org_id"))),
    )
    .post(`${ws}/join`, async (c) =>
      c.json(await requests.join(h.user(c), c.req.param("workspace_id"))),
    )
    .post(`${ws}/access-requests`, async (c) =>
      c.json(await requests.request(h.user(c), c.req.param("workspace_id"))),
    )
    .get(`${ws}/access-requests`, async (c) =>
      c.json(await requests.list(h.user(c), c.req.param("workspace_id"))),
    )
    .post(`${ws}/access-requests/:req_id/approve`, async (c) =>
      c.json(await requests.approve(h.user(c), c.req.param("workspace_id"), c.req.param("req_id"))),
    )
    .post(`${ws}/access-requests/:req_id/reject`, async (c) =>
      c.json(await requests.reject(h.user(c), c.req.param("workspace_id"), c.req.param("req_id"))),
    )
    .get(`${ws}/support-access/events`, async (c) => {
      const ctx = await h.ws(c);
      const { query } = await p.validate(c.req, { query: SupportEventsQuery });
      return c.json(await support.events(ctx, query.page, query.limit));
    })
    .get(`${ws}/support-access/requests`, async (c) =>
      c.json(await support.requests(await h.ws(c))),
    )
    .post(`${ws}/support-access/requests/:request_id/approve`, async (c) =>
      c.json(await support.approve(await h.ws(c), c.req.param("request_id"))),
    )
    .post(`${ws}/support-access/requests/:request_id/deny`, async (c) =>
      c.json(await support.deny(await h.ws(c), c.req.param("request_id"))),
    )
    .get("/api/v2/projects/:project_id/members", async (c) =>
      c.json(await sharing.list(h.user(c), c.req.param("project_id"))),
    )
    .get("/api/v2/projects/:project_id/invites", async (c) =>
      c.json(await sharing.invites(h.user(c), c.req.param("project_id"))),
    )
    .post("/api/v2/projects/:project_id/members", async (c) => {
      const who = h.user(c);
      const { body } = await p.validate(c.req, { body: AddShare });
      return c.json(await sharing.add(who, c.req.param("project_id"), body.data.email));
    })
    .delete("/api/v2/projects/:project_id/members/:user_id", async (c) =>
      c.json(await sharing.revoke(h.user(c), c.req.param("project_id"), c.req.param("user_id"))),
    );
}
