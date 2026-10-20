import { describe, expect, it } from "vitest";
import { turnRefusalOf } from "./turnRefusal";

const refusal = (detail: Record<string, unknown>) =>
	new Error(
		JSON.stringify({ detail: { error: "FREE_TIER_LIMIT", ...detail } }),
	);

describe("turnRefusalOf", () => {
	it("reads a refused turn and a frozen chat", () => {
		expect(turnRefusalOf(refusal({ limit: "chat_turns" }))).toEqual({
			frozen: false,
			monthly: false,
		});
		expect(
			turnRefusalOf(refusal({ limit: "chat_turns", reason: "frozen" })),
		).toEqual({ frozen: true, monthly: false });
	});

	it("reads the month's chats used up as a limit, not an error", () => {
		expect(turnRefusalOf(refusal({ cap: 2, limit: "chats", used: 2 }))).toEqual(
			{ frozen: false, monthly: true },
		);
	});

	it("leaves other failures to the error alert", () => {
		expect(turnRefusalOf(refusal({ limit: "reports" }))).toBeNull();
		expect(turnRefusalOf(new Error("boom"))).toBeNull();
		expect(turnRefusalOf(undefined)).toBeNull();
	});
});
