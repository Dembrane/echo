// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildIssueReportFormData } from "./index";

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
