// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { api, getProjectChatContext, isProjectChatContext } from "./api";

afterEach(() => {
	vi.restoreAllMocks();
});

const context = {
	chat_mode: null,
	conversation_id_list: [],
	conversations: [],
	locked_conversation_id_list: [],
	messages: [],
};

it("accepts the endpoint's shape and rejects anything else", () => {
	expect(isProjectChatContext(context)).toBe(true);
	expect(isProjectChatContext("<!doctype html>")).toBe(false);
	expect(isProjectChatContext({ messages: [] })).toBe(false);
	expect(isProjectChatContext(undefined)).toBe(false);
});

it("returns a well-formed context", async () => {
	vi.spyOn(api, "get").mockResolvedValue(context as never);
	await expect(getProjectChatContext("chat-1")).resolves.toEqual(context);
});

it("throws on a 200 whose body is not the context (e.g. an HTML page)", async () => {
	vi.spyOn(api, "get").mockResolvedValue("<!doctype html>" as never);
	await expect(getProjectChatContext("chat-1")).rejects.toThrow(
		"Malformed chat context response",
	);
});
