import { describe, expect, it } from "vitest";
import { focusedConversationIdsFromPayload } from "./agenticFocus";

describe("focusedConversationIdsFromPayload", () => {
	it("returns the ids from a well-formed payload", () => {
		expect(
			focusedConversationIdsFromPayload({
				content: "hello",
				focused_conversation_ids: ["conv-1", "conv-2"],
			}),
		).toEqual(["conv-1", "conv-2"]);
	});

	it("drops non-string and empty entries", () => {
		expect(
			focusedConversationIdsFromPayload({
				focused_conversation_ids: ["conv-1", 42, null, ""],
			}),
		).toEqual(["conv-1"]);
	});

	it("returns empty for missing or malformed payloads", () => {
		expect(focusedConversationIdsFromPayload(null)).toEqual([]);
		expect(focusedConversationIdsFromPayload("nope")).toEqual([]);
		expect(focusedConversationIdsFromPayload({})).toEqual([]);
		expect(
			focusedConversationIdsFromPayload({ focused_conversation_ids: "conv-1" }),
		).toEqual([]);
	});
});
