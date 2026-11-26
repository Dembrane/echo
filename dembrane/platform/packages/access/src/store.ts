/** The rows access decisions read. One Drizzle implementation, one in-memory twin for tests. */
export interface WorkspaceRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly visibility: "open_to_organisation" | "invite_only" | "private";
  readonly deleted: boolean;
  readonly stickyRemoved: readonly string[];
  readonly inheritOrgMembers: boolean;
  /**
   * Held back from its organisation for a demo staff have not handed over yet (HELD_FOR_DEMO):
   * nobody derives a role in it. Absent reads as not held.
   */
  readonly held?: boolean;
  readonly tier: string | null;
}

export interface MembershipRow {
  readonly role: string;
  readonly customPolicies: unknown;
  readonly source: string;
  /**
   * Staff support rows only: a workspace admin approved this session in the last 24
   * hours (a support access request resolved as approved for this membership).
   */
  readonly supportApproved?: boolean;
  /** Staff support rows only: when that approval's 24 hours end, or null without one. */
  readonly supportChangeUntil?: string | null;
}

export interface ProjectRow {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly visibility: "workspace" | "private";
  readonly deleted: boolean;
  /** Owner of a legacy project that predates workspaces. */
  readonly legacyOwnerDirectusUserId: string | null;
  /** A seeded sample (project.is_sample): it spends the AI budget, but takes no audio and no stats. */
  readonly isSample?: boolean;
}

export interface AccessStore {
  workspace(id: string): Promise<WorkspaceRow | null>;
  /** Active direct membership: not deleted, not expired at `now`. */
  workspaceMembership(
    workspaceId: string,
    appUserId: string,
    now: Date,
  ): Promise<MembershipRow | null>;
  orgRole(orgId: string, appUserId: string): Promise<string | null>;
  project(id: string): Promise<ProjectRow | null>;
  hasProjectShare(projectId: string, appUserId: string): Promise<boolean>;
}
