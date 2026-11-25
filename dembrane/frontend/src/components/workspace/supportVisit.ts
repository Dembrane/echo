import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * A staff member's support visit to one customer workspace (ECHO-863): whether they are in
 * and until when, their request for access, and joining, extending, leaving, asking and
 * withdrawing. Used by "Usage and billing" and by the account page, through one cache.
 */

export type SupportVisitStatus = {
	active: boolean;
	expires_at: string | null;
	/** The visit rests on an approved request: the customer let this person make changes. */
	can_change?: boolean;
};

export type SupportRequestStatus = {
	support_access_enabled: boolean;
	request: {
		id: string;
		status: string;
		created_at: string | null;
	} | null;
};

export const supportVisitKey = (workspaceId: string) =>
	["v2", "admin", "support-access", workspaceId] as const;
export const supportRequestKey = (workspaceId: string) =>
	["v2", "admin", "support-request", workspaceId] as const;

async function send<T>(url: string, init: RequestInit): Promise<T> {
	const res = await fetch(url, { credentials: "include", ...init });
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, err);
	}
	return res.json();
}

async function read<T>(url: string): Promise<T> {
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) throw new Error(`Failed (${res.status})`);
	return res.json();
}

export function useSupportVisit(workspaceId: string) {
	const queryClient = useQueryClient();
	const base = `${API_BASE_URL}/v2/admin/workspaces/${workspaceId}`;
	const visitKey = supportVisitKey(workspaceId);
	const requestKey = supportRequestKey(workspaceId);

	// The caller's own visit, so a reopened control shows "until <time>" and Extend
	// instead of always offering a fresh join.
	const visit = useQuery({
		queryFn: () => read<SupportVisitStatus>(`${base}/join-support`),
		queryKey: visitKey,
	});

	const request = useQuery({
		queryFn: () => read<SupportRequestStatus>(`${base}/support-access/request`),
		queryKey: requestKey,
	});

	const sendRequest = useMutation({
		mutationFn: (message: string) =>
			send(`${base}/support-access/request`, {
				body: JSON.stringify({ message }),
				headers: { "Content-Type": "application/json" },
				method: "POST",
			}),
		onError: (e) => void notifyError(e),
		onSuccess: () => {
			toast.success(t`Request sent. The workspace admins were notified.`);
			queryClient.invalidateQueries({ queryKey: requestKey });
		},
	});

	const cancelRequest = useMutation({
		mutationFn: () =>
			send(`${base}/support-access/request`, { method: "DELETE" }),
		onError: (e) => void notifyError(e),
		onSuccess: () => {
			toast.success(t`Request withdrawn.`);
			queryClient.invalidateQueries({ queryKey: requestKey });
		},
	});

	const join = useMutation({
		mutationFn: () =>
			send<{
				status: "joined" | "extended" | "already_member";
				expires_at: string | null;
			}>(`${base}/join-support`, {
				headers: { "Content-Type": "application/json" },
				method: "POST",
			}),
		onError: (e) => void notifyError(e),
		onSuccess: (data) => {
			if (data.status === "already_member") {
				toast.success(t`You already have access to this workspace.`);
			} else if (data.status === "extended") {
				toast.success(t`Support access extended for another 24 hours.`);
			} else {
				toast.success(
					t`Support access granted. It ends automatically in 24 hours.`,
				);
			}
			queryClient.invalidateQueries({ queryKey: visitKey });
			// Refresh the workspace + project lists so the just-joined workspace
			// shows its projects without a manual refresh.
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
		},
	});

	const leave = useMutation({
		mutationFn: () => send(`${base}/join-support`, { method: "DELETE" }),
		onError: (e) => void notifyError(e),
		onSuccess: () => {
			toast.success(t`Support access ended.`);
			queryClient.invalidateQueries({ queryKey: visitKey });
		},
	});

	const active = visit.data?.active ?? false;
	const pendingRequest =
		request.data?.request?.status === "pending" ? request.data.request : null;
	return {
		active,
		busy:
			join.isPending ||
			leave.isPending ||
			sendRequest.isPending ||
			cancelRequest.isPending,
		/** False on a visit that only reads: joined while the switch was on, never approved. */
		canChange: active && (visit.data?.can_change ?? false),
		cancelRequest,
		expiresAt: visit.data?.expires_at ?? null,
		join,
		leave,
		loading: visit.isLoading || request.isLoading,
		pendingRequest,
		sendRequest,
		/** True until the server says otherwise, as "Usage and billing" always read it. */
		supportEnabled: request.data?.support_access_enabled ?? true,
		visitLoading: visit.isLoading,
	};
}

export type SupportVisit = ReturnType<typeof useSupportVisit>;
