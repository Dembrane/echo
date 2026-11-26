import { describe, expect, it } from "vitest";
import type { NotificationRow } from "@/hooks/useNotifications";
import {
	type PendingSupportRequest,
	waitingRequests,
	workspacesWithRequestNotice,
} from "./supportRequests";

const NOW = new Date("2026-11-25T12:00:00Z");
const daysAgo = (days: number) =>
	new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const notice = (over: Partial<NotificationRow> = {}): NotificationRow => ({
	action: "NAVIGATE_WORKSPACE_SETTINGS",
	actor_avatar: null,
	actor_name: "Sam Staff",
	actor_user_id: null,
	created_at: daysAgo(1),
	event_code: "SUPPORT_ACCESS_REQUESTED",
	expires_at: null,
	id: "n-1",
	message: null,
	params: { request_id: "r-1" },
	read: false,
	refs: {
		chat_id: null,
		conversation_id: null,
		invite_id: null,
		org_id: "o-1",
		project_id: null,
		report_id: null,
		workspace_id: "ws-1",
	},
	scope: "Gemeente Utrecht › Team",
	severity: "action_required",
	title: "dembrane staff requested access to Team",
	...over,
});

const withWorkspace = (workspaceId: string | null) =>
	({
		chat_id: null,
		conversation_id: null,
		invite_id: null,
		org_id: "o-1",
		project_id: null,
		report_id: null,
		workspace_id: workspaceId,
	}) satisfies NotificationRow["refs"];

const pending = (
	over: Partial<PendingSupportRequest> = {},
): PendingSupportRequest => ({
	created_at: daysAgo(1),
	expires_at: null,
	id: "r-1",
	message: null,
	requested_by_name: "Sam Staff",
	...over,
});

describe("workspacesWithRequestNotice", () => {
	it("counts only support access request notifications", () => {
		const rows = [
			notice({ id: "n-1", refs: withWorkspace("ws-1") }),
			notice({
				event_code: "SUPPORT_ACCESS_ENABLED",
				id: "n-2",
				refs: withWorkspace("ws-2"),
			}),
			notice({
				event_code: "MEMBERSHIP_REQUESTED",
				id: "n-3",
				refs: withWorkspace("ws-3"),
			}),
		];
		expect(workspacesWithRequestNotice(rows, NOW)).toEqual(["ws-1"]);
	});

	it("ignores a request notification older than 7 days, the life of a request", () => {
		const rows = [
			notice({
				created_at: daysAgo(8),
				id: "n-old",
				refs: withWorkspace("ws-old"),
			}),
			notice({
				created_at: daysAgo(6),
				id: "n-new",
				refs: withWorkspace("ws-new"),
			}),
		];
		expect(workspacesWithRequestNotice(rows, NOW)).toEqual(["ws-new"]);
	});

	it("names each workspace once, however many requests it has", () => {
		const rows = [
			notice({
				id: "n-1",
				params: { request_id: "r-1" },
				refs: withWorkspace("ws-1"),
			}),
			notice({
				id: "n-2",
				params: { request_id: "r-2" },
				refs: withWorkspace("ws-1"),
			}),
			notice({
				id: "n-3",
				params: { request_id: "r-3" },
				refs: withWorkspace("ws-2"),
			}),
		];
		expect([...workspacesWithRequestNotice(rows, NOW)].sort()).toEqual([
			"ws-1",
			"ws-2",
		]);
	});

	it("skips a notification that names no workspace", () => {
		const rows = [
			notice({ id: "n-1", refs: withWorkspace(null) }),
			notice({ id: "n-2", refs: withWorkspace("ws-2") }),
		];
		expect(workspacesWithRequestNotice(rows, NOW)).toEqual(["ws-2"]);
	});

	it("is empty without notifications", () => {
		expect(workspacesWithRequestNotice([], NOW)).toEqual([]);
	});
});

describe("waitingRequests", () => {
	it("lists every waiting request oldest first, across workspaces", () => {
		const rows = [
			notice({
				id: "n-a",
				params: { request_id: "r-a" },
				refs: withWorkspace("ws-1"),
			}),
			notice({
				id: "n-b",
				params: { request_id: "r-b" },
				refs: withWorkspace("ws-2"),
			}),
			notice({
				id: "n-c",
				params: { request_id: "r-c" },
				refs: withWorkspace("ws-1"),
			}),
		];
		const out = waitingRequests(
			rows,
			{
				"ws-1": [
					pending({ created_at: daysAgo(1), id: "r-a" }),
					pending({ created_at: daysAgo(5), id: "r-c" }),
				],
				"ws-2": [pending({ created_at: daysAgo(3), id: "r-b" })],
			},
			{ "ws-1": "Team", "ws-2": "Lab" },
		);
		expect(out.map((r) => r.id)).toEqual(["r-c", "r-b", "r-a"]);
	});

	it("carries the workspace, its name and the notification that announced the request", () => {
		const rows = [
			notice({
				id: "n-1",
				params: { request_id: "r-1" },
				refs: withWorkspace("ws-1"),
			}),
		];
		const out = waitingRequests(
			rows,
			{
				"ws-1": [
					pending({
						id: "r-1",
						message: "We would like to look at your report settings.",
						requested_by_name: "Sam Staff",
					}),
				],
			},
			{ "ws-1": "Team" },
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			id: "r-1",
			message: "We would like to look at your report settings.",
			notification_id: "n-1",
			requested_by_name: "Sam Staff",
			workspace_id: "ws-1",
			workspace_name: "Team",
		});
	});

	it("falls back to the last part of the notification's scope for a workspace it cannot name", () => {
		const rows = [
			notice({
				id: "n-1",
				params: { request_id: "r-1" },
				refs: withWorkspace("ws-1"),
				scope: "Gemeente Utrecht › Wijkteam Noord",
			}),
		];
		const out = waitingRequests(rows, { "ws-1": [pending({ id: "r-1" })] }, {});
		expect(out[0].workspace_name).toBe("Wijkteam Noord");
	});

	it("prefers the workspace's own name over the notification's scope", () => {
		const rows = [
			notice({
				id: "n-1",
				params: { request_id: "r-1" },
				refs: withWorkspace("ws-1"),
				scope: "Gemeente Utrecht › Old name",
			}),
		];
		const out = waitingRequests(
			rows,
			{ "ws-1": [pending({ id: "r-1" })] },
			{ "ws-1": "New name" },
		);
		expect(out[0].workspace_name).toBe("New name");
	});

	it("matches the notification by its request id, and has none when no notification names the request", () => {
		const rows = [
			notice({
				id: "n-other",
				params: { request_id: "r-other" },
				refs: withWorkspace("ws-1"),
			}),
			notice({
				id: "n-2",
				params: { request_id: "r-2" },
				refs: withWorkspace("ws-1"),
			}),
		];
		const out = waitingRequests(
			rows,
			{
				"ws-1": [
					pending({ created_at: daysAgo(2), id: "r-1" }),
					pending({ created_at: daysAgo(1), id: "r-2" }),
				],
			},
			{ "ws-1": "Team" },
		);
		expect(out.map((r) => [r.id, r.notification_id])).toEqual([
			["r-1", null],
			["r-2", "n-2"],
		]);
	});

	it("is empty when no workspace has a waiting request", () => {
		const rows = [notice({ id: "n-1", refs: withWorkspace("ws-1") })];
		expect(waitingRequests(rows, { "ws-1": [] }, { "ws-1": "Team" })).toEqual(
			[],
		);
	});
});
