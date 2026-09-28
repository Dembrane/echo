import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ApiError,
	inviteToWorkspace,
	parseApiError,
	type WorkspaceInvitePayload,
} from "@/components/invite/api";
import type { InviteRole } from "@/components/invite/RoleSelect";
import { API_BASE_URL } from "@/config";

// Mirrors ProjectShareResponse in server/dembrane/api/v2/project_sharing.py
export interface ProjectShare {
	user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	// The person's workspace role: it decides what they can do on the project.
	workspace_role: string | null;
	granted_by: string | null;
	created_at: string | null;
}

// Error codes the server attaches to structured `detail` objects.
export const NOT_A_MEMBER = "not_a_member";

// Mirrors ProjectPendingInvite in server/dembrane/api/v2/project_sharing.py
export interface ProjectPendingInvite {
	id: string;
	email: string;
	role: string;
	created_at: string | null;
	expires_at: string | null;
}

export const projectInvitesKey = (projectId: string) =>
	["v2", "project-invites", projectId] as const;

// Pending workspace invites that will share this project on accept. Admin-only
// on the server, so callers pass `enabled` from the same admin gate.
export const useProjectPendingInvites = (
	projectId: string | undefined,
	enabled = true,
) =>
	useQuery({
		queryKey: projectInvitesKey(projectId ?? ""),
		queryFn: async (): Promise<ProjectPendingInvite[]> => {
			const res = await fetch(
				`${API_BASE_URL}/v2/projects/${projectId}/invites`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error(await res.text());
			return res.json();
		},
		enabled: Boolean(projectId) && enabled,
		staleTime: 30_000,
	});

export type InviteBatchResult = {
	email: string;
	outcome: PromiseSettledResult<WorkspaceInvitePayload>;
}[];

export type InviteOutcomes = {
	/** Existing accounts: added and shared right away. */
	granted: number;
	/** Invite email actually went out. */
	sent: number;
	/** A pending invite for this project already existed. */
	alreadyPending: number;
	/** Pending invite for a different project; one invite carries one project. */
	otherProject: string[];
	/** Invite row written but the email failed. */
	emailNotSent: string[];
	failed: { email: string; reason: unknown }[];
	/** Nothing needs the admin's attention, so the modal can close. */
	allClean: boolean;
};

// Fold a batch of invite results into what the admin needs to be told.
export function summarizeInviteResults(
	results: InviteBatchResult,
): InviteOutcomes {
	const s: InviteOutcomes = {
		granted: 0,
		sent: 0,
		alreadyPending: 0,
		otherProject: [],
		emailNotSent: [],
		failed: [],
		allClean: false,
	};
	for (const { email, outcome } of results) {
		if (outcome.status === "rejected") {
			s.failed.push({ email, reason: outcome.reason });
			continue;
		}
		const r = outcome.value;
		if (r.project_share === "pending_other_project") {
			s.otherProject.push(email);
		} else if (r.project_share === "granted") {
			s.granted += 1;
		} else if (r.status === "already_invited") {
			s.alreadyPending += 1;
		} else if (r.email_sent) {
			s.sent += 1;
		} else {
			s.emailNotSent.push(email);
		}
	}
	s.allClean =
		s.failed.length === 0 &&
		s.otherProject.length === 0 &&
		s.emailNotSent.length === 0;
	return s;
}

// Invite several people to the workspace and share this project with them on
// join. One round of cache invalidation for the whole batch.
export const useInviteToWorkspaceWithProject = (
	workspaceId: string | null | undefined,
	projectId: string,
	orgId?: string | null,
) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (vars: {
			emails: string[];
			role: InviteRole;
		}): Promise<InviteBatchResult> => {
			if (!workspaceId) {
				throw new ApiError("No workspace selected", 400);
			}
			const settled = await Promise.allSettled(
				vars.emails.map((email) =>
					inviteToWorkspace(workspaceId, email, vars.role, { projectId }),
				),
			);
			return vars.emails.map((email, i) => ({ email, outcome: settled[i] }));
		},
		onSuccess: () => {
			invalidateProjectSharing(queryClient, projectId, workspaceId, orgId);
		},
	});
};

export interface ShareBatchResult {
	shared: string[];
	needsInvite: string[];
	failed: { email: string; message: string }[];
}

// Share a project with several emails in one go. People already on the
// workspace land in `shared`; unknown emails land in `needsInvite` so the
// caller can offer a workspace invite; anything else is reported in `failed`.
// Runs sequentially: the shares endpoint is cheap and order keeps toasts sane.
// What each person can do on the project follows their workspace role.
export async function shareWithEmails(
	emails: string[],
	add: (vars: { email: string }) => Promise<unknown>,
): Promise<ShareBatchResult> {
	const result: ShareBatchResult = { shared: [], needsInvite: [], failed: [] };
	for (const email of emails) {
		try {
			await add({ email });
			result.shared.push(email);
		} catch (err) {
			if (err instanceof ApiError && err.code === NOT_A_MEMBER) {
				result.needsInvite.push(email);
			} else {
				result.failed.push({
					email,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
	return result;
}

async function fetchShares(projectId: string): Promise<ProjectShare[]> {
	const res = await fetch(`${API_BASE_URL}/v2/projects/${projectId}/members`, {
		credentials: "include",
	});
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

export const useProjectShares = (projectId: string | undefined) =>
	useQuery({
		queryKey: ["v2", "project-shares", projectId],
		queryFn: () => fetchShares(projectId as string),
		enabled: Boolean(projectId),
		staleTime: 30_000,
	});

// Cache keys a share or invite from this project can change.
export const invalidateProjectSharing = (
	queryClient: ReturnType<typeof useQueryClient>,
	projectId: string,
	workspaceId?: string | null,
	orgId?: string | null,
) => {
	queryClient.invalidateQueries({
		queryKey: ["v2", "project-shares", projectId],
	});
	// Sharing changes can affect the guard's access decision (esp. on private projects).
	queryClient.invalidateQueries({
		queryKey: ["v2", "project-detail", projectId],
	});
	queryClient.invalidateQueries({ queryKey: projectInvitesKey(projectId) });
	if (workspaceId) {
		queryClient.invalidateQueries({
			queryKey: ["v2", "workspace-settings", workspaceId],
		});
	}
	if (orgId) {
		// Members page pending list.
		queryClient.invalidateQueries({
			queryKey: ["v2", "orgs", orgId, "pending-invites"],
		});
	}
};

// Batch callers pass `invalidate: false` and call invalidateProjectSharing once afterwards.
export const useAddProjectShare = (projectId: string, invalidate = true) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (vars: { email: string }) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/projects/${projectId}/members`,
				{
					body: JSON.stringify(vars),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw parseApiError(res.status, data, "Couldn't add person");
			}
			return res.json() as Promise<ProjectShare>;
		},
		onSuccess: () => {
			if (invalidate) invalidateProjectSharing(queryClient, projectId);
		},
	});
};

export const useRevokeProjectShare = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (userId: string) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/projects/${projectId}/members/${userId}`,
				{ credentials: "include", method: "DELETE" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Couldn't revoke");
			}
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "project-shares", projectId],
			});
			// Sharing changes can affect the guard's access decision
			// (esp. on private projects) — bust the detail cache too.
			queryClient.invalidateQueries({
				queryKey: ["v2", "project-detail", projectId],
			});
		},
	});
};

export const useSetProjectVisibility = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (visibility: "workspace" | "private") => {
			const res = await fetch(
				`${API_BASE_URL}/v2/projects/${projectId}/visibility`,
				{
					body: JSON.stringify({ visibility }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PATCH",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Couldn't change visibility");
			}
			return res.json() as Promise<{ status: string; visibility: string }>;
		},
		onSuccess: () => {
			// Project fetches live under ["projects", ...] (plural) —
			// see frontend/src/components/project/hooks/index.ts:365.
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "project-shares", projectId],
			});
			// Access guard keys off ["v2", "project-detail", projectId].
			queryClient.invalidateQueries({
				queryKey: ["v2", "project-detail", projectId],
			});
		},
	});
};
