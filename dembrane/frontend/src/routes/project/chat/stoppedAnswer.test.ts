import { describe, expect, it } from "vitest";
import { stoppedAnswer } from "./stoppedAnswer";

describe("stoppedAnswer", () => {
	it("returns the partial assistant reply", () => {
		const reply = { content: "Half an ans", id: "kX9fQ2Lm", role: "assistant" };
		expect(
			stoppedAnswer([
				{ content: "What came up?", id: "u1", role: "user" },
				reply,
			]),
		).toBe(reply);
	});

	it("saves nothing when stopped before the first token", () => {
		expect(
			stoppedAnswer([{ content: "What came up?", id: "u1", role: "user" }]),
		).toBeNull();
	});

	it("saves nothing for an empty reply or an empty thread", () => {
		expect(
			stoppedAnswer([{ content: "", id: "a1", role: "assistant" }]),
		).toBeNull();
		expect(stoppedAnswer([])).toBeNull();
	});
});
