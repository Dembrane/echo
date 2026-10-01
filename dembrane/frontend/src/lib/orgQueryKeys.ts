// Canonical React Query keys + dual-namespace invalidation helpers for org-scoped resources during the "organisation"→"orgs" migration.

import type { QueryClient } from "@tanstack/react-query";

const NS_NEW = "orgs" as const;
const NS_OLD = "organisation" as const;

export const orgQueryKeys = {
	// Single org resource (settings, name, top-level fields)
	root: (orgId: string) => ["v2", NS_NEW, orgId] as const,
	// Members list (org People tab + workspace settings members table)
	members: (orgId: string) => ["v2", NS_NEW, orgId, "members"] as const,
	// Workspaces in an org (org overview + invite modal's workspace picker)
	workspaces: (orgId: string) => ["v2", NS_NEW, orgId, "workspaces"] as const,
	// Pending invites (org-wide + per-workspace via key suffix)
	pendingInvites: (orgId: string) =>
		["v2", NS_NEW, orgId, "pending-invites"] as const,
	pendingInvitesForWorkspace: (orgId: string, workspaceId: string) =>
		[
			"v2",
			NS_NEW,
			orgId,
			"pending-invites",
			{ workspaceId },
		] as const,
};

export function invalidateOrgMembersEverywhere(
	qc: QueryClient,
	orgId: string,
): void {
	qc.invalidateQueries({ queryKey: orgQueryKeys.members(orgId) });
	qc.invalidateQueries({ queryKey: ["v2", NS_OLD, orgId, "members"] });
}

export function invalidateOrgWorkspacesEverywhere(
	qc: QueryClient,
	orgId: string,
): void {
	qc.invalidateQueries({ queryKey: orgQueryKeys.workspaces(orgId) });
	qc.invalidateQueries({ queryKey: ["v2", NS_OLD, orgId, "workspaces"] });
}

// Explicit per-workspace invalidation: prefix-matching can miss the object-suffix key on some React Query versions.
export function invalidatePendingInvitesEverywhere(
	qc: QueryClient,
	orgId: string,
	workspaceId?: string,
): void {
	qc.invalidateQueries({ queryKey: orgQueryKeys.pendingInvites(orgId) });
	if (workspaceId) {
		qc.invalidateQueries({
			queryKey: orgQueryKeys.pendingInvitesForWorkspace(orgId, workspaceId),
		});
	}
}
