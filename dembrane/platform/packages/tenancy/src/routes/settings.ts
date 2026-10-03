import { ValidationError } from "@dembrane/core";
import { type Env, v } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { Hono } from "hono";
import type { TenancyDeps } from "../deps";
import { projectService } from "../service/projects";
import { settingsService } from "../service/settings";
import { helpers } from "./common";
import {
  ChangeRole,
  CreateProject,
  DataOwnership,
  ProjectListQuery,
  UpdateSettings,
} from "./models";

/** A multipart upload's `file` part, or FastAPI's 422 for a missing UploadFile. */
export async function uploadedFile(c: {
  req: { header(n: string): string | undefined; parseBody(): Promise<Record<string, unknown>> };
}): Promise<File> {
  const type = c.req.header("content-type") ?? "";
  const body = type.includes("multipart/form-data") ? await c.req.parseBody() : {};
  if (body.file instanceof File) return body.file;
  const issues: v.Issue[] = [
    {
      type: "missing",
      loc: ["body", "file"],
      msg: "Field required",
      input: null,
      url: "https://errors.pydantic.dev/2.12/v/missing",
    },
  ];
  throw new ValidationError("validation.invalid_input", {
    details: issues,
    params: { fields: v.fieldProblems(issues) },
  });
}

/** /api/v2/workspaces/:id settings, members, logo and the workspace's project list. */
export function settingsRoutes(deps: TenancyDeps) {
  const svc = settingsService(deps);
  const projects = projectService(deps);
  const h = helpers(deps);
  const base = "/api/v2/workspaces/:workspace_id";
  return new Hono<Env>()
    .get(`${base}/settings`, async (c) => c.json(await svc.get(await h.ws(c))))
    .patch(`${base}/settings`, async (c) => {
      const ctx = await h.ws(c);
      const { body } = await p.validate(c.req, { body: UpdateSettings });
      return c.json(await svc.update(ctx, body.data, body.fieldsSet));
    })
    .patch(`${base}/data-ownership`, async (c) => {
      const ctx = await h.ws(c);
      const { body } = await p.validate(c.req, { body: DataOwnership });
      return c.json(await svc.dataOwnership(ctx, body.data));
    })
    .post(`${base}/logo`, async (c) => {
      const ctx = await h.ws(c);
      return c.json(await svc.uploadLogo(ctx, await uploadedFile(c)));
    })
    .delete(`${base}/logo`, async (c) => c.json(await svc.removeLogo(await h.ws(c))))
    .delete(`${base}/members/:membership_id`, async (c) =>
      c.json(await svc.removeMember(await h.ws(c), c.req.param("membership_id"))),
    )
    .patch(`${base}/members/:membership_id`, async (c) => {
      const ctx = await h.ws(c);
      const { body } = await p.validate(c.req, { body: ChangeRole });
      return c.json(await svc.changeRole(ctx, c.req.param("membership_id"), body.data.role));
    })
    .get(`${base}/projects`, async (c) => {
      const ctx = await h.ws(c);
      const { query } = await p.validate(c.req, { query: ProjectListQuery });
      return c.json(await projects.list(ctx, query));
    })
    .post(`${base}/projects`, async (c) => {
      const ctx = await h.ws(c);
      const { body } = await p.validate(c.req, { body: CreateProject });
      const created = await projects.create(ctx, body.data);
      await deps.onProjectCreated?.(created.id);
      return c.json(created);
    });
}
