import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

/**
 * Hooks for the in-app notification inbox.
 *
 * Backend lives at /v2/me/notifications. Row shape mirrors the response
 * from `server/dembrane/api/v2/notifications.py:NotificationRow`.
 *
 * Announcements share the drawer UI pattern but have their own hooks in
 * `@/components/announcement/hooks`. When the consolidated inbox design
 * lands, this file + that one can collapse into a single store.
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

export interface NotificationTranslation {
	languages_code: string;
	title: string;
	message: string | null;
}

export type NotificationAction =
	| "NONE"
	| "NAVIGATE_WS"
	| "NAVIGATE_PROJECT"
	| "NAVIGATE_REPORT"
	| "NAVIGATE_CHAT"
	| "NAVIGATE_INVITE"
	| "NAVIGATE_TEAM_SETTINGS"
	| "NAVIGATE_WORKSPACE_SETTINGS";

export interface NotificationRow {
	id: string;
	event_code: string;
	action: NotificationAction;
	level: "info" | "urgent";
	created_at: string | null;
	expires_at: string | null;
	read: boolean;
	actor_user_id: string | null;
	actor_name: string | null;
	actor_avatar: string | null;
	refs: NotificationRefs;
	translation: NotificationTranslation | null;
}

async function fetchNotifications(): Promise<NotificationRow[]> {
	const res = await fetch(`${API_BASE_URL}/v2/me/notifications`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

async function fetchUnreadCount(): Promise<number> {
	const res = await fetch(
		`${API_BASE_URL}/v2/me/notifications/unread-count`,
		{ credentials: "include" },
	);
	if (!res.ok) return 0;
	const body = await res.json().catch(() => ({}));
	return typeof body.unread === "number" ? body.unread : 0;
}

export const useNotifications = () =>
	useQuery({
		queryKey: ["v2", "notifications"],
		queryFn: fetchNotifications,
		staleTime: 30_000,
		// Light polling so the badge stays honest without a websocket.
		refetchInterval: 60_000,
	});

export const useUnreadNotificationCount = () =>
	useQuery({
		queryKey: ["v2", "notifications", "unread-count"],
		queryFn: fetchUnreadCount,
		staleTime: 30_000,
		refetchInterval: 60_000,
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
		},
	});
};

export const useMarkAllNotificationsRead = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/me/notifications/read-all`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) throw new Error("Couldn't mark all as read");
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "notifications"] });
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
	row: Pick<NotificationRow, "action" | "refs">,
): string | null {
	const { action, refs } = row;
	switch (action) {
		case "NAVIGATE_WS":
			return refs.workspace_id ? `/w/${refs.workspace_id}/projects` : null;
		case "NAVIGATE_PROJECT":
			return refs.project_id
				? `/projects/${refs.project_id}/overview`
				: null;
		case "NAVIGATE_REPORT":
			return refs.project_id && refs.report_id
				? `/projects/${refs.project_id}/reports/${refs.report_id}`
				: null;
		case "NAVIGATE_CHAT":
			return refs.project_id && refs.chat_id
				? `/projects/${refs.project_id}/chats/${refs.chat_id}`
				: null;
		case "NAVIGATE_INVITE":
			return "/invites";
		case "NAVIGATE_TEAM_SETTINGS":
			return refs.org_id ? `/t/${refs.org_id}/settings` : null;
		case "NAVIGATE_WORKSPACE_SETTINGS":
			return refs.workspace_id ? `/w/${refs.workspace_id}/settings` : null;
		default:
			return null;
	}
}
