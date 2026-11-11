import { describe, expect, it } from "vitest";
import { aiBudgetRefusalOf, turnRefusalOf } from "./turnRefusal";

const refusal = (detail: Record<string, unknown>) =>
	new Error(
		JSON.stringify({ detail: { error: "FREE_TIER_LIMIT", ...detail } }),
	);

describe("turnRefusalOf", () => {
	it("reads the sample project's refused turn", () => {
		expect(turnRefusalOf(refusal({ cap: 10, limit: "chat_turns" }))).toBe(true);
	});

	it("leaves other failures alone", () => {
		expect(turnRefusalOf(refusal({ limit: "chats" }))).toBe(false);
		expect(turnRefusalOf(refusal({ limit: "ai_budget" }))).toBe(false);
		expect(turnRefusalOf(new Error("boom"))).toBe(false);
		expect(turnRefusalOf(undefined)).toBe(false);
	});
});

describe("aiBudgetRefusalOf", () => {
	it("reads a used-up AI budget with its reset time", () => {
		expect(
			aiBudgetRefusalOf(
				refusal({
					limit: "ai_budget",
					percent: 100,
					resets_at: "2026-12-01T00:00:00Z",
				}),
			),
		).toEqual({ percent: 100, resetsAt: "2026-12-01T00:00:00Z" });
	});

	it("reads the coded body too", () => {
		const coded = new Error(
			JSON.stringify({
				action: "upgrade",
				code: "billing.tier_limit",
				params: { limit: "ai_budget" },
			}),
		);
		expect(aiBudgetRefusalOf(coded)).toEqual({ percent: null, resetsAt: null });
	});

	it("is null for anything else", () => {
		expect(aiBudgetRefusalOf(refusal({ limit: "chat_turns" }))).toBeNull();
		expect(aiBudgetRefusalOf(new Error("boom"))).toBeNull();
		expect(aiBudgetRefusalOf(undefined)).toBeNull();
	});
});
