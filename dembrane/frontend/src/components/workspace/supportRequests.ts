import { t } from "@lingui/core/macro";
import {
	queryOptions,
	useMutation,
	useQueries,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { API_BASE_URL } from "@/config";
import {
	type NotificationRow,
	useNotifications,
} from "@/hooks/useNotifications";
import { useWorkspace } from "@/hooks/useWorkspace";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * A workspace's support access requests that wait for an admin: read by the settings
 * section and by the consent dialog, through one cache, and answered through one mutation.
 */

export type PendingSupportRequest = {
	id: string;
	requested_by_name: string;
	message: string | null;
	created_at: string | null;
	expires_at: string | null;
};

export type WaitingSupportRequest = PendingSupportRequest & {
	workspace_id: string;
	workspace_name: string;
	notification_id: string | null;
};

export const SUPPORT_REQUEST_EVENT = "SUPPORT_ACCESS_REQUESTED";
// A request expires after 7 days, so an older notice cannot announce a waiting one.
const REQUEST_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export const supportRequestsKey = (workspaceId: string) =>
	["v2", "support-access", "requests", workspaceId] as const;

export async function fetchPendingSupportRequests(
	workspaceId: string,
): Promise<{ requests: PendingSupportRequest[] }> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/support-access/requests`,
		{ credentials: "include" },
	);
	if (!res.ok) throw new Error(`Failed (${res.status})`);
	return res.json();
}

export const pendingSupportRequestsQuery = (workspaceId: string) =>
	queryOptions({
		queryFn: () => fetchPendingSupportRequests(workspaceId),
		queryKey: supportRequestsKey(workspaceId),
	});

const isRequestNotice = (row: NotificationRow) =>
	row.event_code === SUPPORT_REQUEST_EVENT && Boolean(row.refs.workspace_id);

const requestIdOf = (row: NotificationRow) => {
	const id = row.params?.request_id;
	return typeof id === "string" ? id : null;
};

/** Workspace ids with a request notification younger than 7 days, each once. */
export function workspacesWithRequestNotice(
	rows: NotificationRow[],
	now: Date,
): string[] {
	const out = new Set<string>();
	for (const row of rows) {
		if (!isRequestNotice(row) || !row.created_at) continue;
		const age = now.getTime() - new Date(row.created_at).getTime();
		if (!(age < REQUEST_LIFE_MS)) continue;
		out.add(row.refs.workspace_id as string);
	}
	return [...out];
}

// "Org › Workspace": the workspace is the last part.
const workspaceFromScope = (scope: string | null) =>
	scope?.split("›").pop()?.trim() || "";

/** Every waiting request, oldest first, with its workspace name and notification. */
export function waitingRequests(
	rows: NotificationRow[],
	pendingByWorkspace: Record<string, PendingSupportRequest[]>,
	workspaceNames: Record<string, string>,
): WaitingSupportRequest[] {
	const notices = rows.filter(isRequestNotice);
	const out: WaitingSupportRequest[] = [];
	for (const [workspaceId, pending] of Object.entries(pendingByWorkspace)) {
		const ofWorkspace = notices.filter(
			(n) => n.refs.workspace_id === workspaceId,
		);
		for (const request of pending) {
			const notice = ofWorkspace.find((n) => requestIdOf(n) === request.id);
			out.push({
				...request,
				notification_id: notice?.id ?? null,
				workspace_id: workspaceId,
				workspace_name:
					workspaceNames[workspaceId] ||
					workspaceFromScope((notice ?? ofWorkspace[0])?.scope ?? null),
			});
		}
	}
	const at = (r: WaitingSupportRequest) =>
		r.created_at ? new Date(r.created_at).getTime() : Number.POSITIVE_INFINITY;
	return out.sort((a, b) => at(a) - at(b));
}

/** Request notices whose request a workspace's loaded list does not hold, as [workspace, request]. */
export function unlistedRequestNotices(
	rows: NotificationRow[],
	loaded: Record<string, PendingSupportRequest[]>,
): [string, string][] {
	const out: [string, string][] = [];
	for (const row of rows) {
		const workspaceId = row.refs.workspace_id;
		const requestId = requestIdOf(row);
		if (!isRequestNotice(row) || !workspaceId || !requestId) continue;
		const list = loaded[workspaceId];
		if (list && !list.some((r) => r.id === requestId))
			out.push([workspaceId, requestId]);
	}
	return out;
}

/**
 * The waiting requests of every workspace that recently sent a request notification. A
 * workspace that refuses the list (the caller is no longer its admin) has none.
 */
export function useWaitingSupportRequests(): WaitingSupportRequest[] {
	const { data: rows = [] } = useNotifications();
	const { workspaces } = useWorkspace();
	const queryClient = useQueryClient();
	const workspaceIds = workspacesWithRequestNotice(rows, new Date());
	const results = useQueries({
		queries: workspaceIds.map((id) => ({
			...pendingSupportRequestsQuery(id),
			retry: false,
		})),
	});
	const pendingByWorkspace = Object.fromEntries(
		results.map((r, i) => [workspaceIds[i], r.data?.requests ?? []]),
	);

	// A new notice can name a request that a workspace's cached list predates: that list is
	// fetched again, once per request. Notices already there when a list first loads are
	// answered or expired requests, so they fetch nothing.
	const loaded = Object.fromEntries(
		results.flatMap((r, i) =>
			r.isSuccess ? [[workspaceIds[i], r.data.requests]] : [],
		),
	);
	const unlisted = unlistedRequestNotices(rows, loaded);
	const unlistedKey = unlisted.map((u) => u.join(":")).join(",");
	const loadedKey = Object.keys(loaded).join(",");
	const known = useRef({
		requests: new Set<string>(),
		workspaces: new Set<string>(),
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: the two keys stand for unlisted and loaded.
	useEffect(() => {
		const firstLoad = new Set(
			Object.keys(loaded).filter((w) => !known.current.workspaces.has(w)),
		);
		for (const w of firstLoad) known.current.workspaces.add(w);
		for (const [workspaceId, requestId] of unlisted) {
			if (known.current.requests.has(requestId)) continue;
			known.current.requests.add(requestId);
			if (!firstLoad.has(workspaceId))
				void queryClient.invalidateQueries({
					queryKey: supportRequestsKey(workspaceId),
				});
		}
	}, [unlistedKey, loadedKey]);
	const names = Object.fromEntries(workspaces.map((w) => [w.id, w.name]));
	return waitingRequests(rows, pendingByWorkspace, names);
}

/** mutate({ workspaceId, requestId, decision: "approve" | "deny" }) with its toasts and invalidation. */
export function useResolveSupportRequest() {
	const queryClient = useQueryClient();
	const invalidateAll = () => {
		queryClient.invalidateQueries({ queryKey: ["v2", "support-access"] });
		queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
	};
	return useMutation({
		mutationFn: async ({
			workspaceId,
			requestId,
			decision,
		}: {
			workspaceId: string;
			requestId: string;
			decision: "approve" | "deny";
		}) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/support-access/requests/${requestId}/${decision}`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new ApiRequestError(res.status, err);
			}
			return res.json();
		},
		onError: (e) => {
			void notifyError(e);
			invalidateAll();
		},
		onSuccess: (_data, vars) => {
			toast.success(
				vars.decision === "approve"
					? t`Access granted for 24 hours.`
					: t`Request declined.`,
			);
			invalidateAll();
		},
	});
}
