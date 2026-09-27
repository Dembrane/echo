import {
  customPolicies,
  normaliseRole,
  type Policy,
  roleHas,
  type WorkspaceRole,
} from "./policies";
import type { AccessStore, ProjectRow, WorkspaceRow } from "./store";

export interface Principal {
  /** Null until onboarding creates the app_user row; such users reach only legacy projects. */
  readonly appUserId: string | null;
  readonly directusUserId: string;
}

export interface WorkspaceAccess {
  readonly workspace: WorkspaceRow;
  readonly role: WorkspaceRole;
  readonly source: "direct" | "inherited" | "staff_support";
  readonly extra: readonly Policy[];
}

export interface ProjectAccess {
  readonly project: ProjectRow;
  readonly role: WorkspaceRole;
  readonly source: "workspace" | "project_share" | "legacy";
  readonly extra: readonly Policy[];
  /** Null for legacy projects, which have no workspace and no tier. */
  readonly tier: string | null;
}

/**
 * The role a user holds in a workspace (spec 2.3). A direct, unexpired membership always
 * wins, even when an inherited one would rank higher. Otherwise the role is derived from
 * the org: owners get admin everywhere, admins get admin on open workspaces, members only
 * through the legacy inherit flag, billing never.
 */
export async function resolveWorkspace(
  store: AccessStore,
  workspaceId: string,
  who: Principal,
  now: Date,
): Promise<WorkspaceAccess | null> {
  if (!who.appUserId) return null;
  const workspace = await store.workspace(workspaceId);
  if (!workspace || workspace.deleted) return null;

  const direct = await store.workspaceMembership(workspaceId, who.appUserId, now);
  if (direct) {
    const role = normaliseRole(direct.role);
    if (!role) return null;
    return {
      workspace,
      role,
      source: direct.source === "staff_support" ? "staff_support" : "direct",
      extra: customPolicies(direct.customPolicies),
    };
  }
  if (!workspace.orgId) return null;
  const derived = deriveWorkspaceRole(
    workspace,
    await store.orgRole(workspace.orgId, who.appUserId),
    who.appUserId,
  );
  return derived ? { workspace, role: derived, source: "inherited", extra: [] } : null;
}

/**
 * The org-derived part of the ladder, pure. Exported so rollups that list who can reach a
 * workspace (member counts, previews) count exactly what access grants.
 */
export function deriveWorkspaceRole(
  ws: Pick<WorkspaceRow, "stickyRemoved" | "visibility" | "inheritOrgMembers">,
  orgRole: string | null,
  appUserId: string,
): WorkspaceRole | null {
  if (ws.stickyRemoved.includes(appUserId)) return null;
  if (orgRole === "owner") return "admin";
  if (ws.visibility !== "open_to_organisation") return null;
  if (orgRole === "admin") return "admin";
  if (orgRole === "member" && ws.inheritOrgMembers) return "member";
  return null;
}

/**
 * The role a user holds on a project (spec 2.3). Shares never cross workspaces. A private
 * project is visible to workspace admins and owners, and to others only with a share. A
 * role without project:read (workspace billing) gets no project access at all.
 */
export async function resolveProject(
  store: AccessStore,
  projectId: string,
  who: Principal,
  now: Date,
): Promise<ProjectAccess | null> {
  const project = await store.project(projectId);
  if (!project || project.deleted) return null;

  if (project.workspaceId === null) {
    // Legacy projects predate workspaces; only their creator reaches them. Removed once
    // every legacy project is moved into its owner's personal workspace.
    return project.legacyOwnerDirectusUserId === who.directusUserId
      ? { project, role: "owner", source: "legacy", extra: [], tier: null }
      : null;
  }

  const ws = await resolveWorkspace(store, project.workspaceId, who, now);
  if (!ws || !roleHas(ws.role, "project:read", ws.extra)) return null;

  const base = { project, role: ws.role, extra: ws.extra, tier: ws.workspace.tier };
  if (project.visibility === "workspace") return { ...base, source: "workspace" };
  if (ws.role === "admin" || ws.role === "owner") return { ...base, source: "workspace" };
  const shared = who.appUserId !== null && (await store.hasProjectShare(projectId, who.appUserId));
  return shared ? { ...base, source: "project_share" } : null;
}
