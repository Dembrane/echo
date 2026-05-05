import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

export interface MyPendingInvite {
	id: string;
	workspace_id: string;
	workspace_name: string;
	org_name: string;
	role: string;
	invited_by_name: string | null;
	created_at: string | null;
	expires_at: string | null;
}

async function fetchMyInvites(): Promise<MyPendingInvite[]> {
	const res = await fetch(`${API_BASE_URL}/v2/me/invites`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

export const useMyInvites = ({ enabled = true }: { enabled?: boolean } = {}) =>
	useQuery({
		enabled,
		queryFn: fetchMyInvites,
		queryKey: ["v2", "me", "invites"],
		staleTime: 30_000,
	});

export const useAcceptInvite = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (inviteId: string) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/me/invites/${inviteId}/accept`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const err = new Error(data.detail || "Failed to accept invite");
				// Plumb status so callers can branch on 402 (cap reached)
				// without parsing the message — keeps UI tone i18n-safe.
				(err as Error & { status?: number }).status = res.status;
				throw err;
			}
			return res.json() as Promise<{ workspace_id: string }>;
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
		},
	});
};

export const useDeclineInvite = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (inviteId: string) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/me/invites/${inviteId}/decline`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to decline invite");
			}
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
		},
	});
};

export const useAcceptInviteByHash = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			hash,
			claimedRole,
		}: {
			hash: string;
			claimedRole?: string | null;
		}) => {
			const res = await fetch(`${API_BASE_URL}/v2/me/invites/accept-by-hash`, {
				body: JSON.stringify({ claimed_role: claimedRole ?? null, hash }),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const err = new Error(data.detail || "Failed to accept invite");
				(err as Error & { status?: number }).status = res.status;
				throw err;
			}
			return res.json() as Promise<{
				workspace_id: string;
				workspace_name: string;
			}>;
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
		},
	});
};
