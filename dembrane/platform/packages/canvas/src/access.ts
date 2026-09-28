import {
  type Access,
  type AccessStore,
  type Policy,
  type Principal,
  type ProjectAccess,
  resolveProject,
} from "@dembrane/access";
import { ForbiddenError, NotFoundError } from "@dembrane/core";
import type { CanvasStore, Row } from "./storage";
import { isUuid } from "./storage";

/**
 * Canvas access in the order the BFF checked it: the caller must be onboarded and reach the
 * project (404 otherwise, never confirming it exists), the canvas feature must be on
 * globally and for this project (404 "Not found", hiding the beta), and only then is the
 * policy checked (403 "Not allowed"). The decision itself always comes from @dembrane/access.
 */
export interface AccessDeps {
  readonly access: Access;
  readonly accessStore: AccessStore;
  readonly store: CanvasStore;
  readonly canvasEnabled: boolean;
}

export interface CanvasAccess {
  readonly project: Row;
  readonly access: ProjectAccess;
}

function notFound(): NotFoundError {
  return new NotFoundError("canvas.feature_off");
}

export function requireCanvasEnabled(d: AccessDeps): void {
  if (!d.canvasEnabled) throw notFound();
}

async function reach(d: AccessDeps, who: Principal, projectId: string) {
  if (!who.appUserId) throw new ForbiddenError("access.not_onboarded");
  const project = isUuid(projectId) ? await d.store.project(projectId) : null;
  if (!project || project.deleted_at) throw new NotFoundError("project.not_found");
  const pa = await resolveProject(d.accessStore, projectId, who, new Date());
  if (!pa) throw new NotFoundError("project.not_found");
  return { project, pa };
}

async function requirePolicy(d: AccessDeps, who: Principal, projectId: string, policy: Policy) {
  try {
    return await d.access.project(who, projectId, policy);
  } catch (err) {
    if (err instanceof ForbiddenError) throw new ForbiddenError("access.forbidden");
    throw err;
  }
}

/** resolve_project_access, then the canvas flags, then each policy in order. */
export async function canvasProject(
  d: AccessDeps,
  who: Principal,
  projectId: string,
  ...policies: Policy[]
): Promise<CanvasAccess> {
  const { project, pa } = await reach(d, who, projectId);
  if (!d.canvasEnabled || !project.is_canvas_enabled) throw notFound();
  let access = pa;
  for (const p of policies) access = await requirePolicy(d, who, projectId, p);
  return { project, access };
}

/**
 * A canvas by its report id: the report must exist in a project the caller reaches with
 * report:view, the project must have canvas on, the caller needs project:read and the
 * report must be a canvas. Extra policies (project:update) follow.
 */
export async function canvasReport(
  d: AccessDeps,
  who: Principal,
  reportId: string,
  ...policies: Policy[]
): Promise<CanvasAccess & { report: Row }> {
  const report = await d.store.report(reportId);
  if (!report || report.deleted_at || !report.project_id)
    throw new NotFoundError("report.not_found");
  const projectId = String(report.project_id);
  const { project } = await reach(d, who, projectId);
  await requirePolicy(d, who, projectId, "report:view");
  if (!d.canvasEnabled || !project.is_canvas_enabled) throw notFound();
  let access = await requirePolicy(d, who, projectId, "project:read");
  if (report.kind !== "canvas") throw new NotFoundError("canvas.not_found");
  for (const p of policies) access = await requirePolicy(d, who, projectId, p);
  return { project, access, report };
}
