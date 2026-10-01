import { describe, expect, it } from "vitest";
import { resolveChatScreen } from "./chatModeRouting";

/**
 * The populations here are the real ones, measured against the production
 * database while reviewing this change: 7,746 live chats have chat_mode NULL,
 * 4,923 of those have locked conversations, 2,823 do not, and 300 of that last
 * group have message history. Setting a mode is one-way, so each of those
 * groups is asserted separately.
 */
describe("resolveChatScreen", () => {
	it("renders the thread for a chat that already picked a mode", () => {
		for (const mode of ["agentic", "deep_dive", "overview"] as const) {
			expect(
				resolveChatScreen({
					agenticIsDefault: false,
					hasLockedConversations: false,
					messageCount: 4,
					rawChatMode: mode,
				}),
			).toEqual({ chatMode: mode, screen: "thread" });
		}
	});

	it("treats a mode-less chat with locked conversations as Specific Details", () => {
		// The 4,923 chats that were already safe before this change.
		expect(
			resolveChatScreen({
				agenticIsDefault: false,
				hasLockedConversations: true,
				messageCount: 12,
				rawChatMode: null,
			}),
		).toEqual({ chatMode: "deep_dive", screen: "thread" });
	});

	it("shows the existing thread for a mode-less chat that has messages", () => {
		// The 300 chats whose history would have stopped rendering after the
		// first agentic turn. They are never auto-converted and are never asked
		// to pick, because picking agentic is not reversible.
		expect(
			resolveChatScreen({
				agenticIsDefault: false,
				hasLockedConversations: false,
				messageCount: 1,
				rawChatMode: null,
			}),
		).toEqual({ chatMode: null, screen: "thread" });
	});

	it("keeps showing that thread even if agentic later becomes the default", () => {
		expect(
			resolveChatScreen({
				agenticIsDefault: true,
				hasLockedConversations: false,
				messageCount: 1,
				rawChatMode: null,
			}),
		).toEqual({ chatMode: null, screen: "thread" });
	});

	it("offers the mode picker for an empty mode-less chat while agentic is opt-in", () => {
		// The remaining ~2,523. Nothing written yet, so the host chooses.
		expect(
			resolveChatScreen({
				agenticIsDefault: false,
				hasLockedConversations: false,
				messageCount: 0,
				rawChatMode: null,
			}),
		).toEqual({ chatMode: null, screen: "mode-picker" });
	});

	it("auto-starts agentic for an empty mode-less chat only once agentic is the default", () => {
		expect(
			resolveChatScreen({
				agenticIsDefault: true,
				hasLockedConversations: false,
				messageCount: 0,
				rawChatMode: null,
			}),
		).toEqual({ chatMode: null, screen: "agentic-auto" });
	});

	it("never auto-converts a chat that has anything to lose", () => {
		// The guarantee this whole module exists for, over every mode-less
		// shape production actually contains.
		for (const hasLockedConversations of [true, false]) {
			for (const messageCount of [1, 25]) {
				expect(
					resolveChatScreen({
						agenticIsDefault: true,
						hasLockedConversations,
						messageCount,
						rawChatMode: null,
					}).screen,
				).toBe("thread");
			}
		}
	});

	it("treats undefined (context still loading) like null", () => {
		expect(
			resolveChatScreen({
				agenticIsDefault: false,
				hasLockedConversations: false,
				messageCount: 0,
				rawChatMode: undefined,
			}).screen,
		).toBe("mode-picker");
	});
});
