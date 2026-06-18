import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

// workspace_id/workspace_name present only when type === "workspace".
export interface PendingInvite {
	id: string;
	type: "org" | "workspace";
	email: string;
	role: string;
	workspace_id: string | null;
	workspace_name: string | null;
	created_at: string | null;
	expires_at: string | null;
	invited_by_id: string | null;
	invited_by_name: string | null;
	invited_by_email: string | null;
	invite_url: string | null;
}

const pendingInvitesKey = (orgId: string, workspaceId?: string) =>
	workspaceId
		? (["v2", "orgs", orgId, "pending-invites", { workspaceId }] as const)
		: (["v2", "orgs", orgId, "pending-invites"] as const);

async function fetchPendingInvites(
	orgId: string,
	workspaceId?: string,
): Promise<PendingInvite[]> {
	const params = new URLSearchParams();
	if (workspaceId) params.set("workspace_id", workspaceId);
	const query = params.toString();
	const url =
		`${API_BASE_URL}/v2/orgs/${orgId}/pending-invites` +
		(query ? `?${query}` : "");
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: `Failed to load pending invites (${res.status})`,
		);
	}
	return res.json();
}

export const usePendingInvites = ({
	orgId,
	workspaceId,
	enabled = true,
}: {
	orgId: string | null | undefined;
	workspaceId?: string;
	enabled?: boolean;
}) =>
	useQuery({
		enabled: Boolean(orgId) && enabled,
		queryFn: () => fetchPendingInvites(orgId as string, workspaceId),
		// Stable disabled key keeps dev tooling under the same namespace.
		queryKey: pendingInvitesKey(orgId ?? "", workspaceId),
		staleTime: 30_000,
	});

export const useResendInvite = ({
	orgId,
	workspaceId,
}: {
	orgId: string | null | undefined;
	workspaceId?: string;
}) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (
			inviteId: string,
		): Promise<{ email_sent: boolean; type: "org" | "workspace" }> => {
			const res = await fetch(`${API_BASE_URL}/v2/invites/${inviteId}/resend`, {
				credentials: "include",
				method: "POST",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const err = new Error(
					data.detail || `Failed to resend invite (${res.status})`,
				);
				(err as Error & { status?: number }).status = res.status;
				throw err;
			}
			return res.json();
		},
		onSettled: () => {
			if (!orgId) return;
			queryClient.invalidateQueries({
				queryKey: pendingInvitesKey(orgId, workspaceId),
			});
			// Invalidate the org-wide key too: workspace-scoped resend should refresh the org members surface.
			if (workspaceId) {
				queryClient.invalidateQueries({
					queryKey: ["v2", "orgs", orgId, "pending-invites"],
				});
			}
		},
	});
};

export const useRevokeInvite = ({
	orgId,
	workspaceId,
}: {
	orgId: string | null | undefined;
	workspaceId?: string;
}) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (
			inviteId: string,
		): Promise<{ type: "org" | "workspace" }> => {
			const res = await fetch(`${API_BASE_URL}/v2/invites/${inviteId}`, {
				credentials: "include",
				method: "DELETE",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const err = new Error(
					data.detail || `Failed to revoke invite (${res.status})`,
				);
				(err as Error & { status?: number }).status = res.status;
				throw err;
			}
			return res.json();
		},
		onError: (_err, _inviteId, context) => {
			if (!context) return;
			for (const [key, snap] of context.snapshots) {
				// biome-ignore lint/suspicious/noExplicitAny: snapshot is the
				// previously-cached value; restoring it as-is is the point.
				queryClient.setQueryData(key as any, snap);
			}
		},
		// Optimistic remove; onError rolls back, onSettled refetches.
		onMutate: async (inviteId: string) => {
			if (!orgId) return { snapshots: [] as Array<[unknown, unknown]> };
			const keys = workspaceId
				? [pendingInvitesKey(orgId, workspaceId), pendingInvitesKey(orgId)]
				: [pendingInvitesKey(orgId)];
			const snapshots: Array<[unknown, unknown]> = [];
			for (const key of keys) {
				await queryClient.cancelQueries({ queryKey: key });
				const prev = queryClient.getQueryData<PendingInvite[]>(key);
				snapshots.push([key, prev]);
				if (prev) {
					queryClient.setQueryData(
						key,
						prev.filter((inv) => inv.id !== inviteId),
					);
				}
			}
			return { snapshots };
		},
		onSettled: () => {
			if (!orgId) return;
			queryClient.invalidateQueries({
				queryKey: pendingInvitesKey(orgId, workspaceId),
			});
			if (workspaceId) {
				queryClient.invalidateQueries({
					queryKey: ["v2", "orgs", orgId, "pending-invites"],
				});
			}
			// Pending invites count against the seat pool; refresh so the InviteMemberCard re-enables immediately.
			if (workspaceId) {
				queryClient.invalidateQueries({
					queryKey: ["v2", "workspace-settings", workspaceId],
				});
				queryClient.invalidateQueries({
					queryKey: ["v2", "workspace-usage", workspaceId],
				});
			}
			// Refresh the InviteModal's seats_used_including_pending so the freed seat reflects immediately.
			queryClient.invalidateQueries({
				queryKey: ["v2", "orgs", orgId, "workspaces", "invite-modal"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "organisation", orgId, "workspaces"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "orgs", orgId, "workspaces"],
			});
			queryClient.invalidateQueries({ queryKey: ["v2", "me", "invites"] });  // invitee's own list
		},
	});
};
