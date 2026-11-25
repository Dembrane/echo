import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * A staff member's support visit to one customer workspace (ECHO-863): whether they are in
 * and until when, their request for access, and joining, extending, leaving, asking and
 * withdrawing. "Usage and billing" reads one workspace here; the account page reads its list
 * of workspaces in one call and uses only the actions.
 */

export type SupportVisitStatus = {
	active: boolean;
	expires_at: string | null;
	/** The visit rests on an approved request: the customer let this person make changes. */
	can_change?: boolean;
	/** When that approval's 24 hours end; extending the visit does not move it. */
	change_until?: string | null;
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
/** The account page's list of an organisation's workspaces, with the caller's visits. */
export const orgWorkspacesKey = (orgId: string) =>
	["v2", "admin", "org-workspaces", orgId] as const;
const ORG_WORKSPACES = ["v2", "admin", "org-workspaces"] as const;

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

/**
 * Joining, extending, leaving, asking and withdrawing, without reading anything: the account
 * page reads every workspace in one call, and each answer refreshes that list too.
 */
export function useSupportVisitActions(workspaceId: string) {
	const queryClient = useQueryClient();
	const base = `${API_BASE_URL}/v2/admin/workspaces/${workspaceId}`;
	const refresh = (key: readonly unknown[]) => {
		queryClient.invalidateQueries({ queryKey: key });
		queryClient.invalidateQueries({ queryKey: ORG_WORKSPACES });
	};

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
			refresh(supportRequestKey(workspaceId));
		},
	});

	const cancelRequest = useMutation({
		mutationFn: () =>
			send(`${base}/support-access/request`, { method: "DELETE" }),
		onError: (e) => void notifyError(e),
		onSuccess: () => {
			toast.success(t`Request withdrawn.`);
			refresh(supportRequestKey(workspaceId));
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
			refresh(supportVisitKey(workspaceId));
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
			refresh(supportVisitKey(workspaceId));
		},
	});

	return {
		busy:
			join.isPending ||
			leave.isPending ||
			sendRequest.isPending ||
			cancelRequest.isPending,
		cancelRequest,
		join,
		leave,
		sendRequest,
	};
}

export type SupportVisitActions = ReturnType<typeof useSupportVisitActions>;

/** The actions above, with the caller's visit and request to one workspace. */
export function useSupportVisit(workspaceId: string) {
	const actions = useSupportVisitActions(workspaceId);
	const base = `${API_BASE_URL}/v2/admin/workspaces/${workspaceId}`;

	// The caller's own visit, so a reopened control shows "until <time>" and Extend
	// instead of always offering a fresh join.
	const visit = useQuery({
		queryFn: () => read<SupportVisitStatus>(`${base}/join-support`),
		queryKey: supportVisitKey(workspaceId),
	});

	const request = useQuery({
		queryFn: () => read<SupportRequestStatus>(`${base}/support-access/request`),
		queryKey: supportRequestKey(workspaceId),
	});

	const active = visit.data?.active ?? false;
	const pendingRequest =
		request.data?.request?.status === "pending" ? request.data.request : null;
	return {
		...actions,
		active,
		/** False on a visit that only reads: joined while the switch was on, never approved. */
		canChange: active && (visit.data?.can_change ?? false),
		expiresAt: visit.data?.expires_at ?? null,
		loading: visit.isLoading || request.isLoading,
		pendingRequest,
		/** True until the server says otherwise, as "Usage and billing" always read it. */
		supportEnabled: request.data?.support_access_enabled ?? true,
		visitLoading: visit.isLoading,
	};
}

export type SupportVisit = ReturnType<typeof useSupportVisit>;
