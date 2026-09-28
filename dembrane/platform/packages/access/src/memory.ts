import type { AccessStore, MembershipRow, ProjectRow, WorkspaceRow } from "./store";

type Membership = MembershipRow & {
  workspaceId: string;
  appUserId: string;
  deleted?: boolean;
  expiresAt?: Date | null;
};

/** In-memory twin of the Drizzle store: the same contract, used by the rule tests. */
export class MemoryAccessStore implements AccessStore {
  workspaces = new Map<string, WorkspaceRow>();
  projects = new Map<string, ProjectRow>();
  memberships: Membership[] = [];
  orgRoles = new Map<string, string>();
  shares = new Set<string>();

  async workspace(id: string) {
    return this.workspaces.get(id) ?? null;
  }
  async workspaceMembership(workspaceId: string, appUserId: string, now: Date) {
    return (
      this.memberships.find(
        (m) =>
          m.workspaceId === workspaceId &&
          m.appUserId === appUserId &&
          !m.deleted &&
          (!m.expiresAt || m.expiresAt > now),
      ) ?? null
    );
  }
  async orgRole(orgId: string, appUserId: string) {
    return this.orgRoles.get(`${orgId}:${appUserId}`) ?? null;
  }
  async project(id: string) {
    return this.projects.get(id) ?? null;
  }
  async hasProjectShare(projectId: string, appUserId: string) {
    return this.shares.has(`${projectId}:${appUserId}`);
  }
}
