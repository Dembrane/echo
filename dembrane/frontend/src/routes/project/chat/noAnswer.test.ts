import { describe, expect, it } from "vitest";
import { isNoAnswer } from "./noAnswer";

describe("isNoAnswer", () => {
	it("spots the stream's no-answer code", () => {
		expect(isNoAnswer(new Error("chat.no_answer"))).toBe(true);
	});

	it("leaves other failures to the generic message", () => {
		expect(
			isNoAnswer(
				new Error("An error occurred while processing the chat response."),
			),
		).toBe(false);
		expect(isNoAnswer(undefined)).toBe(false);
	});
});
