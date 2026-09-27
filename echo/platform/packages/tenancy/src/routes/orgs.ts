import type { Env } from "@echo/http";
import { p } from "@echo/legacy-shape";
import { Hono } from "hono";
import type { TenancyDeps } from "../deps";
import { orgService } from "../service/orgs";
import { helpers } from "./common";
import {
  ChangeRole,
  CreateOrg,
  InviteToOrg,
  PendingInvitesQuery,
  UpdateOrg,
  UsageQuery,
} from "./models";
import { uploadedFile } from "./settings";

/** /api/v2/orgs: organisations, their members, invites, workspaces, usage and projects. */
export function orgRoutes(deps: TenancyDeps) {
  const svc = orgService(deps);
  const h = helpers(deps);
  const org = "/api/v2/orgs/:org_id";
  const id = (c: { req: { param(n: "org_id"): string } }) => c.req.param("org_id");
  return new Hono<Env>()
    .get("/api/v2/orgs", async (c) => c.json(await svc.list(h.user(c))))
    .post("/api/v2/orgs", async (c) => {
      const who = h.user(c);
      const { body } = await p.validate(c.req, { body: CreateOrg });
      return c.json(await svc.create(who, body.data.name));
    })
    .get(org, async (c) => c.json(await svc.get(h.user(c), id(c))))
    .patch(org, async (c) => {
      const who = h.user(c);
      const { body } = await p.validate(c.req, { body: UpdateOrg });
      return c.json(await svc.update(who, id(c), body.data));
    })
    .post(`${org}/logo`, async (c) => {
      const who = h.user(c);
      const file = await uploadedFile(c);
      return c.json(await svc.uploadLogo(who, id(c), file));
    })
    .delete(`${org}/logo`, async (c) => c.json(await svc.removeLogo(h.user(c), id(c))))
    .get(`${org}/members`, async (c) => c.json(await svc.members(h.user(c), id(c))))
    .get(`${org}/pending-invites`, async (c) => {
      const who = h.user(c);
      const { query } = await p.validate(c.req, { query: PendingInvitesQuery });
      return c.json(await svc.pendingInvites(who, id(c), query.workspace_id));
    })
    .post(`${org}/invites`, async (c) => {
      const who = h.user(c);
      const { body } = await p.validate(c.req, { body: InviteToOrg });
      return c.json(await svc.invite(who, id(c), body.data));
    })
    .get(`${org}/workspaces`, async (c) => c.json(await svc.workspaces(h.user(c), id(c))))
    .patch(`${org}/members/:user_id`, async (c) => {
      const who = h.user(c);
      const { body } = await p.validate(c.req, { body: ChangeRole });
      return c.json(await svc.changeRole(who, id(c), c.req.param("user_id"), body.data.role));
    })
    .delete(`${org}/members/:user_id`, async (c) =>
      c.json(await svc.removeMember(h.user(c), id(c), c.req.param("user_id"))),
    )
    .get(`${org}/usage`, async (c) => {
      const who = h.user(c);
      const { query } = await p.validate(c.req, { query: UsageQuery });
      return c.json(await svc.usage(who, id(c), query.month_offset));
    })
    .get(`${org}/projects`, async (c) => c.json(await svc.projects(h.user(c), id(c))))
    .get(`${org}/referral-ledger`, async (c) => c.json(await svc.referralLedger(h.user(c), id(c))));
}
