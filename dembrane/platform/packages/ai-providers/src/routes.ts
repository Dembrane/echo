import { type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { Hono } from "hono";
import { type AiProvidersDeps, readOrg, readProject, setProject } from "./service";

const { model, required, nullable, str } = p;

/**
 * The AI provider screens' routes: an organisation's owners and admins read what the account
 * allows, and a project's admins pick among it. Staff set the account's side in @dembrane/staff.
 */
export function aiProviderRoutes(d: AiProvidersDeps) {
  const app = new Hono<Env>();
  app.get("/api/v2/orgs/:org_id/ai-providers", async (c) =>
    c.json(await readOrg(d, requireUser(c), c.req.param("org_id"))),
  );
  app.get("/api/v2/projects/:project_id/ai-provider", async (c) =>
    c.json(await readProject(d, requireUser(c), c.req.param("project_id"))),
  );
  app.put("/api/v2/projects/:project_id/ai-provider", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ provider: required(nullable(str())) }),
    });
    return c.json(await setProject(d, who, c.req.param("project_id"), body.data.provider));
  });
  return app;
}
