// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { portalDefaults } from "@/components/project/portal-editor/portalForm";
import { buildPreviewMessage } from "@/components/project/portal-editor/preview/buildPreviewMessage";
import { apiNoAuth, initiateConversation } from "@/lib/api";
import {
	answerRequests,
	PREVIEW_ARTIFACT_ID,
	PREVIEW_CONVERSATION_ID,
	previewEntry,
	seedPreview,
} from "./fixtures";

vi.mock("@/components/common/Toaster", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const seeded = () => {
	const client = new QueryClient();
	const message = buildPreviewMessage({
		highlight: null,
		legal: null,
		screen: "verify-topics",
		tags: [],
		topics: {
			available_topics: [
				{ is_custom: false, key: "actions", translations: {} },
				{ is_custom: false, key: "agreements", translations: {} },
			],
			selected_topics: ["actions", "agreements"],
		} as never,
		values: portalDefaults({ id: "p1", language: "en" } as Project, [
			"actions",
			"agreements",
		]),
	});
	seedPreview(client, "p1", message);
	return client;
};

let undo: (() => void) | null = null;
afterEach(() => {
	undo?.();
	undo = null;
});

// ECHO-1062: the host clicks through the preview; the portal's own requests are answered
// inside the frame, and nothing else is.
describe("answerRequests", () => {
	it("starts the made-up conversation without sending anything", async () => {
		const send = vi.spyOn(window, "fetch");
		const xhr = vi.spyOn(window, "XMLHttpRequest");
		undo = answerRequests(seeded(), "p1");
		const conversation = await initiateConversation({
			name: "Table 3",
			pin: "",
			projectId: "p1",
			source: "PORTAL_AUDIO",
			tagIdList: [],
		});
		expect(conversation.id).toBe(PREVIEW_CONVERSATION_ID);
		expect(send).not.toHaveBeenCalled();
		expect(xhr).not.toHaveBeenCalled();
	});

	it("makes a Verify draft for the chosen topic, and approves it", async () => {
		undo = answerRequests(seeded(), "p1");
		const generated = (await apiNoAuth.post("/verify/generate", {
			conversation_id: PREVIEW_CONVERSATION_ID,
			topic_list: ["agreements"],
		})) as { artifact_list: { id: string; key: string }[] };
		expect(generated.artifact_list[0]).toMatchObject({
			id: PREVIEW_ARTIFACT_ID,
			key: "agreements",
		});
		const approved = (await apiNoAuth.put(
			`/verify/artifact/${PREVIEW_ARTIFACT_ID}`,
			{ approvedAt: "2026-11-12T10:00:00Z" },
		)) as { approved_at: string };
		expect(approved.approved_at).toBe("2026-11-12T10:00:00Z");
	});

	it("refuses anything it does not answer", async () => {
		undo = answerRequests(seeded(), "p1");
		await expect(
			apiNoAuth.post("/participant/projects/p1/conversations/x/chunks", {}),
		).rejects.toThrow("sends nothing");
		await expect(apiNoAuth.get("/participant/projects/p2")).rejects.toThrow(
			"sends nothing",
		);
		await expect(apiNoAuth.delete("/verify/artifact/x")).rejects.toThrow(
			"sends nothing",
		);
	});
});

describe("previewEntry", () => {
	it("opens each screen at the portal's own address", () => {
		expect(previewEntry("explore", "nl", "p1")).toBe(
			`/nl-NL/p1/conversation/${PREVIEW_CONVERSATION_ID}?echo=1`,
		);
		expect(previewEntry("verify-topics", "en", "p1")).toBe(
			`/en-US/p1/conversation/${PREVIEW_CONVERSATION_ID}/verify`,
		);
	});
});
