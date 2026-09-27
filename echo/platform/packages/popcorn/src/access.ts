import {
  type Access,
  meetsTier,
  type Policy,
  type Principal,
  type ProjectAccess,
  TIER_REQUIRED,
} from "@echo/access";
import { ForbiddenError, NotFoundError } from "@echo/core";
import type { PopcornFlags } from "./service";
import { REPORT_KIND } from "./settings";
import { isUuid, type PopcornStore, type Row } from "./storage";

/**
 * Popcorn access in the order the BFF checked it: the report must exist, the caller must be
 * onboarded and reach its project (404 otherwise, never confirming it exists), report:view,
 * then the feature flags (404 "Not found", hiding the beta), then project:read and the
 * report's kind. Every decision comes from @echo/access; only the wording is local.
 */

export interface AccessDeps {
  readonly access: Access;
  readonly store: PopcornStore;
  readonly flags: PopcornFlags;
}

export interface Reached {
  readonly project: Row;
  readonly access: ProjectAccess;
}

const notFound = () => new NotFoundError("Not found");

/** require_popcorn_enabled: legacy decks stay while Present rolls out on its own switch. */
export function requirePopcornEnabled(flags: PopcornFlags): void {
  if (!(flags.present || flags.canvas)) throw notFound();
}

export function requirePresentEnabled(flags: PopcornFlags): void {
  if (!flags.present) throw notFound();
}

/** require_project_popcorn_enabled: without Present, the project must have opted into canvas. */
export function requireProjectPopcornEnabled(flags: PopcornFlags, project: Row | null): void {
  requirePopcornEnabled(flags);
  if (!project || project.deleted_at) throw notFound();
  if (!flags.present && !(flags.canvas && project.is_canvas_enabled)) throw notFound();
}

/** access.require(policy) with the BFF's refusal texts. */
async function requirePolicy(d: AccessDeps, who: Principal, projectId: string, policy: Policy) {
  try {
    return await d.access.project(who, projectId, policy);
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
    const required = TIER_REQUIRED[policy];
    if (required) {
      const tier = await d.access.project(who, projectId, "project:read").then(
        (a) => a.tier,
        () => null,
      );
      if (tier !== null && !meetsTier(tier, required))
        throw new ForbiddenError(`This action requires the ${required} tier (currently ${tier}).`);
    }
    throw new ForbiddenError("Not allowed");
  }
}

/** resolve_project_access: onboarded, project live, some role on it. */
export async function reachProject(
  d: AccessDeps,
  who: Principal,
  projectId: string,
): Promise<Reached> {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  const project = isUuid(projectId) ? await d.store.project(projectId) : null;
  if (!project || project.deleted_at) throw new NotFoundError("Project not found");
  const access = await d.access.project(who, projectId, "project:read").catch((err) => {
    if (err instanceof ForbiddenError) return null;
    throw err;
  });
  // A role without project:read reaches nothing (spec 8.2): the same 404 as no role.
  if (!access) throw new NotFoundError("Project not found");
  return { project, access };
}

/** RPA, the popcorn flags for the project, then each policy in order. */
export async function popcornProject(
  d: AccessDeps,
  who: Principal,
  projectId: string,
  ...policies: Policy[]
): Promise<Reached> {
  const reached = await reachProject(d, who, projectId);
  requireProjectPopcornEnabled(d.flags, reached.project);
  let access = reached.access;
  for (const p of policies) access = await requirePolicy(d, who, projectId, p);
  return { project: reached.project, access };
}

/** Plain RPA plus policies, with no feature gate (Present's project entry points). */
export async function projectWith(
  d: AccessDeps,
  who: Principal,
  projectId: string,
  ...policies: Policy[]
): Promise<Reached> {
  const reached = await reachProject(d, who, projectId);
  let access = reached.access;
  for (const p of policies) access = await requirePolicy(d, who, projectId, p);
  return { project: reached.project, access };
}

/** Whether a policy holds, without throwing: `access.allows`. */
export async function allows(d: AccessDeps, who: Principal, projectId: string, policy: Policy) {
  return d.access.project(who, projectId, policy).then(
    () => true,
    () => false,
  );
}

/** _require_popcorn: the report, report:view, the flags, project:read and kind popcorn. */
export async function popcornReport(
  d: AccessDeps,
  who: Principal,
  reportId: string,
  ...policies: Policy[]
): Promise<Reached & { report: Row }> {
  const report = await d.store.report(reportId);
  if (!report || report.deleted_at || !report.project_id)
    throw new NotFoundError("Report not found");
  const projectId = String(report.project_id);
  const { project } = await reachProject(d, who, projectId);
  await requirePolicy(d, who, projectId, "report:view");
  requireProjectPopcornEnabled(d.flags, project);
  let access = await requirePolicy(d, who, projectId, "project:read");
  if (report.kind !== REPORT_KIND) throw new NotFoundError("Popcorn not found");
  for (const p of policies) access = await requirePolicy(d, who, projectId, p);
  return { project, access, report };
}

export { requirePolicy };
