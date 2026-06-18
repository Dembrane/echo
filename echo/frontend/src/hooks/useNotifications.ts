import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

/**
 * Hooks for the in-app notification inbox.
 *
 * Backend lives at /v2/me/notifications. Row shape mirrors the response
 * from `server/dembrane/api/v2/notifications.py:NotificationRow`.
 *
 * Rendered by `@/components/inbox/Inbox`, which also pulls the
 * announcement collection through `@/components/announcement/hooks`
 * for the sibling "Announcements" tab. Each store stays separate —
 * they're different collections with different lifecycles — but the
 * UI presents them as one inbox.
 */

export interface NotificationRefs {
	org_id: string | null;
	workspace_id: string | null;
	project_id: string | null;
	chat_id: string | null;
	report_id: string | null;
	conversation_id: string | null;
	invite_id: string | null;
}

export type NotificationAction =
	| "NONE"
	| "NAVIGATE_WS"
	| "NAVIGATE_PROJECT"
	| "NAVIGATE_REPORT"
	| "NAVIGATE_CHAT"
	| "NAVIGATE_INVITE"
	| "NAVIGATE_ORGANISATION_SETTINGS"
	| "NAVIGATE_WORKSPACE_SETTINGS"
	| "NAVIGATE_BILLING"
	| "NAVIGATE_TRAINING";

export type NotificationSeverity = "info" | "action_required" | "destructive";

export interface NotificationRow {
	id: string;
	event_code: string;
	severity: NotificationSeverity;
	action: NotificationAction;
	title: string;
	message: string | null;
	scope: string | null;
	params: Record<string, unknown> | null;
	created_at: string | null;
	expires_at: string | null;
	read: boolean;
	actor_user_id: string | null;
	actor_name: string | null;
	actor_avatar: string | null;
	refs: NotificationRefs;
}

async function fetchNotifications(): Promise<NotificationRow[]> {
	const res = await fetch(`${API_BASE_URL}/v2/me/notifications`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

async function fetchUnreadCount(): Promise<number> {
	const res = await fetch(`${API_BASE_URL}/v2/me/notifications/unread-count`, {
		credentials: "include",
	});
	if (!res.ok) return 0;
	const body = await res.json().catch(() => ({}));
	return typeof body.unread === "number" ? body.unread : 0;
}

export const useNotifications = () =>
	useQuery({
		queryFn: fetchNotifications,
		queryKey: ["v2", "notifications"],
		// Light polling so the badge stays honest without a websocket.
		refetchInterval: 60_000,
		staleTime: 30_000,
	});

export const useUnreadNotificationCount = () =>
	useQuery({
		queryFn: fetchUnreadCount,
		queryKey: ["v2", "notifications", "unread-count"],
		refetchInterval: 60_000,
		staleTime: 30_000,
	});

export const useMarkNotificationRead = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (notificationId: string) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/me/notifications/${notificationId}/read`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Couldn't mark as read");
			}
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "notifications"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "notifications", "unread-count"],
			});
		},
	});
};

export const useMarkAllNotificationsRead = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const res = await fetch(`${API_BASE_URL}/v2/me/notifications/read-all`, {
				credentials: "include",
				method: "POST",
			});
			if (!res.ok) throw new Error("Couldn't mark all as read");
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "notifications"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "notifications", "unread-count"],
			});
		},
	});
};

/**
 * Translate a notification's codified action into a concrete URL.
 *
 * Returns null if the action is NONE or the required refs are missing.
 * Centralises the URL mapping so callers (click handlers) don't each
 * reinvent it. Keep aligned with `NotificationAction` enum on the
 * server side.
 */
export function resolveNotificationHref(
	row: Pick<NotificationRow, "action" | "refs" | "event_code">,
): string | null {
	const { action, refs, event_code } = row;
	switch (action) {
		case "NAVIGATE_WS":
			return refs.workspace_id ? `/w/${refs.workspace_id}/home` : null;
		case "NAVIGATE_PROJECT":
			return refs.project_id && refs.workspace_id
				? `/w/${refs.workspace_id}/projects/${refs.project_id}/home`
				: null;
		case "NAVIGATE_REPORT":
			return refs.project_id && refs.workspace_id
				? `/w/${refs.workspace_id}/projects/${refs.project_id}/report`
				: null;
		case "NAVIGATE_CHAT":
			return refs.project_id && refs.chat_id && refs.workspace_id
				? `/w/${refs.workspace_id}/projects/${refs.project_id}/chats/${refs.chat_id}`
				: null;
		case "NAVIGATE_INVITE":
			return "/invites";
		case "NAVIGATE_ORGANISATION_SETTINGS":
			return refs.org_id ? `/o/${refs.org_id}/overview` : null;
		case "NAVIGATE_WORKSPACE_SETTINGS":
			if (!refs.workspace_id) return null;
			// Workspace access requests are approved on the Members tab.
			if (event_code === "MEMBERSHIP_REQUESTED") {
				return `/w/${refs.workspace_id}/members`;
			}
			return `/w/${refs.workspace_id}/settings/general`;
		case "NAVIGATE_BILLING":
			// Billing lives on the payer: a workspace-scoped account links to the
			// workspace billing tab, an org-scoped one to the org billing tab.
			if (refs.workspace_id) {
				return `/w/${refs.workspace_id}/settings/billing`;
			}
			if (refs.org_id) {
				return `/o/${refs.org_id}/settings/billing`;
			}
			return null;
		case "NAVIGATE_TRAINING":
			return refs.org_id ? `/o/${refs.org_id}/training` : null;
		default:
			return null;
	}
}
