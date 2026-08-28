// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	applyOptimisticFeedback,
	buildIssueReportFormData,
	fetchResponseFeedback,
	isPersistedMessageId,
	type ResponseFeedback,
	removeOptimisticFeedback,
	responseFeedbackQueryKey,
} from "./index";

describe("buildIssueReportFormData", () => {
	it("includes all fields and files", () => {
		const file = new File(["x"], "shot.png", { type: "image/png" });
		const fd = buildIssueReportFormData({
			attachments: [file],
			locale: "en-US",
			message: "Broken button",
			pageUrl: "https://dashboard.dembrane.com/en",
			projectId: "p-1",
			sessionReplayUrl: "https://eu.posthog.com/replay/abc",
			userAgent: "ua",
			workspaceId: "w-1",
		});
		expect(fd.get("message")).toBe("Broken button");
		expect(fd.get("workspace_id")).toBe("w-1");
		expect(fd.get("project_id")).toBe("p-1");
		expect(fd.get("page_url")).toBe("https://dashboard.dembrane.com/en");
		expect(fd.get("locale")).toBe("en-US");
		expect(fd.get("user_agent")).toBe("ua");
		expect(fd.get("session_replay_url")).toBe(
			"https://eu.posthog.com/replay/abc",
		);
		expect(fd.getAll("attachments")).toHaveLength(1);
	});

	it("omits empty optional fields", () => {
		const fd = buildIssueReportFormData({ attachments: [], message: "m" });
		expect(fd.get("workspace_id")).toBeNull();
		expect(fd.get("project_id")).toBeNull();
		expect(fd.get("page_url")).toBeNull();
		expect(fd.get("session_replay_url")).toBeNull();
		expect(fd.getAll("attachments")).toHaveLength(0);
	});
});

describe("fetchResponseFeedback chunking", () => {
	it("splits more than 200 ids across requests and merges the results", async () => {
		const ids = Array.from({ length: 450 }, (_, i) => `m-${i}`);
		const calls: string[] = [];
		const fetchMock = vi.fn(async (url: string) => {
			const sent =
				new URL(url, "http://localhost").searchParams.get("target_ids") ?? "";
			calls.push(sent);
			const first = sent.split(",")[0];
			return {
				json: async () => [
					{
						comment: null,
						date_created: null,
						id: `fb-${first}`,
						rating: "up",
						reasons: [],
						target_id: first,
						target_type: "chat_message",
					},
				],
				ok: true,
			} as unknown as Response;
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await fetchResponseFeedback("chat_message", ids);
			expect(calls).toHaveLength(3);
			expect(calls.map((c) => c.split(",").length)).toEqual([200, 200, 50]);
			expect(Object.keys(result)).toEqual(["m-0", "m-200", "m-400"]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("response feedback helpers", () => {
	const existing: Record<string, ResponseFeedback> = {
		"m-1": {
			comment: null,
			date_created: null,
			id: "fb-1",
			rating: "up",
			reasons: [],
			target_id: "m-1",
			target_type: "chat_message",
		},
	};

	it("builds a stable key regardless of id order", () => {
		expect(responseFeedbackQueryKey("chat_message", ["b", "a"])).toEqual(
			responseFeedbackQueryKey("chat_message", ["a", "b"]),
		);
	});

	it("flips a rating optimistically and keeps other rows", () => {
		const next = applyOptimisticFeedback(existing, {
			rating: "down",
			reasons: ["incorrect"],
			targetId: "m-1",
			targetType: "chat_message",
		});
		expect(next["m-1"].rating).toBe("down");
		expect(next["m-1"].reasons).toEqual(["incorrect"]);
		expect(next["m-1"].id).toBe("fb-1");
	});

	it("adds a placeholder row for a new target", () => {
		const next = applyOptimisticFeedback(existing, {
			rating: "up",
			targetId: "m-2",
			targetType: "chat_message",
		});
		expect(next["m-2"].rating).toBe("up");
		expect(next["m-2"].id).toBe("optimistic");
	});

	it("removes a row", () => {
		expect(removeOptimisticFeedback(existing, "m-1")).toEqual({});
	});
});

describe("isPersistedMessageId", () => {
	it("accepts a Directus uuid, in either case", () => {
		expect(isPersistedMessageId("7f1c2f4e-0b2a-4c1d-9e3f-1234567890ab")).toBe(
			true,
		);
		expect(isPersistedMessageId("7F1C2F4E-0B2A-4C1D-9E3F-1234567890AB")).toBe(
			true,
		);
	});

	it("rejects ai-sdk nanoids, the init placeholder, and non-strings", () => {
		expect(isPersistedMessageId("kX9fQ2LmN7pR3sT4v")).toBe(false);
		expect(isPersistedMessageId("init")).toBe(false);
		expect(isPersistedMessageId(undefined)).toBe(false);
		expect(isPersistedMessageId(null)).toBe(false);
	});
});
