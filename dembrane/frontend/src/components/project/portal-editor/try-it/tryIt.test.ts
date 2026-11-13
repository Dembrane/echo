import { describe, expect, it } from "vitest";
import { sameSettings, tryRequest } from "./tryIt";

const values = {
	get_reply_mode: "summarize",
	get_reply_prompt: "Ask about shade.",
	language: "nl" as const,
	verification_topics: ["actions", "agreements"],
};

describe("tryRequest", () => {
	it("sends Explore's prompt only in custom mode, as the server reads it", () => {
		expect(tryRequest("explore", values)?.get_reply_prompt).toBeNull();
		expect(
			tryRequest("explore", { ...values, get_reply_mode: "custom" })
				?.get_reply_prompt,
		).toBe("Ask about shade.");
	});

	it("a prompt typed outside custom mode leaves an Explore result current", () => {
		expect(
			sameSettings(
				tryRequest("explore", values),
				tryRequest("explore", { ...values, get_reply_prompt: "Other." }),
			),
		).toBe(true);
		expect(
			sameSettings(
				tryRequest("explore", values),
				tryRequest("explore", { ...values, language: "en" as const }),
			),
		).toBe(false);
	});

	it("tries Verify's first chosen topic, and nothing without one", () => {
		expect(tryRequest("verify", values)).toEqual({
			kind: "verify",
			language: "nl",
			source: "sample",
			topic_key: "actions",
		});
		expect(
			tryRequest("verify", { ...values, verification_topics: [] }),
		).toBeNull();
	});
});
