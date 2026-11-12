import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	exactAiCost,
	formatAiCost,
	formatShare,
	groupFeatures,
	providerName,
	sharePercents,
} from "./aiCostBreakdown";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

describe("formatAiCost", () => {
	it("shows four decimals, cut off and never rounded up", () => {
		expect(formatAiCost(1_000_000)).toBe("€1.0000");
		expect(formatAiCost(1_234_567_890)).toBe("€1,234.5678");
		expect(formatAiCost(679_238)).toBe("€0.6792");
		expect(formatAiCost(679_299)).toBe("€0.6792");
		expect(formatAiCost(1_199)).toBe("€0.0011");
		expect(formatAiCost(100)).toBe("€0.0001");
		expect(formatAiCost(0)).toBe("€0.0000");
	});

	it("never shows a non-zero cost as zero", () => {
		expect(formatAiCost(99)).toBe("< €0.0001");
		expect(formatAiCost(1)).toBe("< €0.0001");
	});

	it("shows the stored micro-euros in full for the hover", () => {
		expect(exactAiCost(679_299)).toBe("€0.679299");
		expect(exactAiCost(1)).toBe("€0.000001");
	});
});

describe("sharePercents", () => {
	it("adds to 100 where plain rounding gave 101", () => {
		// The staging account: 72 + 15 + 5 + 5 + 4 = 101 when each is rounded alone.
		const costs = [489_238, 100_000, 32_000, 32_000, 26_000];
		expect(costs.map((c) => Math.round((c * 100) / 679_238))).toEqual([
			72, 15, 5, 5, 4,
		]);
		const percents = sharePercents(costs);
		expect(percents.reduce((s, p) => s + p, 0)).toBe(100);
		expect(percents).toEqual([72, 15, 5, 4, 4]);
	});

	it("is all zeros when nothing was spent", () => {
		expect(sharePercents([0, 0])).toEqual([0, 0]);
		expect(sharePercents([])).toEqual([]);
	});
});

describe("formatShare", () => {
	it("never hides a non-zero cost as 0%", () => {
		expect(formatShare(50, 10)).toBe("50%");
		expect(formatShare(100, 10)).toBe("100%");
		expect(formatShare(0, 10)).toBe("<1%");
		expect(formatShare(0, 0)).toBe("0%");
	});
});

describe("groupFeatures", () => {
	it("groups operations by feature, with shares, most expensive first", () => {
		const groups = groupFeatures([
			{
				calls: 10,
				cost_micro_eur: 600_000,
				group: "recording",
				group_label: "Recording",
				label: "Transcription",
				operation: "conversations.chunk",
			},
			{
				calls: 3,
				cost_micro_eur: 100_000,
				group: "chat",
				group_label: "Chat",
				label: "Replies",
				operation: "POST /api/chats/:chat_id",
			},
			{
				calls: 2,
				cost_micro_eur: 50_000,
				group: "recording",
				group_label: "Recording",
				label: "Finalize and summary",
				operation: "conversations.finalize",
			},
			{
				calls: 5,
				cost_micro_eur: 250_000,
				group: "chat",
				group_label: "Chat",
				label: "Suggestions",
				operation: "GET /api/chats/:chat_id/suggestions",
			},
		]);
		expect(
			groups.map((g) => [g.group, g.label, g.cost_micro_eur, g.calls]),
		).toEqual([
			["recording", "Recording", 650_000, 12],
			["chat", "Chat", 350_000, 8],
		]);
		expect(groups[0]?.share).toBeCloseTo(0.65);
		expect(groups[1]?.share).toBeCloseTo(0.35);
		expect(groups[1]?.operations.map((o) => [o.operation, o.label])).toEqual([
			["GET /api/chats/:chat_id/suggestions", "Suggestions"],
			["POST /api/chats/:chat_id", "Replies"],
		]);
		expect(groups[1]?.operations[0]?.share).toBeCloseTo(0.25);
		expect(groups.map((g) => g.percent)).toEqual([65, 35]);
		// Operations add to 100 across the whole account.
		expect(groups.flatMap((g) => g.operations.map((o) => o.percent))).toEqual([
			60, 5, 25, 10,
		]);
	});

	it("shows the names the API sent, without classifying", () => {
		const [g] = groupFeatures([
			{
				cost_micro_eur: 10,
				group: "map",
				group_label: "Kaart",
				label: "Groepen",
				operation: "GET /api/chats/:chat_id/suggestions",
			},
		]);
		expect([g?.group, g?.label, g?.operations[0]?.label]).toEqual([
			"map",
			"Kaart",
			"Groepen",
		]);
	});

	it("keeps calls optional and a zero total at zero shares", () => {
		const groups = groupFeatures([
			{
				cost_micro_eur: 0,
				group: "other",
				group_label: "Other",
				label: "Unlabelled",
				operation: "",
			},
		]);
		expect(groups).toEqual([
			{
				calls: 0,
				cost_micro_eur: 0,
				group: "other",
				label: "Other",
				operations: [
					{
						calls: 0,
						cost_micro_eur: 0,
						label: "Unlabelled",
						operation: "",
						percent: 0,
						share: 0,
					},
				],
				percent: 0,
				share: 0,
			},
		]);
	});
});

describe("groupFeatures with an older API", () => {
	it("puts entries without names under Other, labelled by operation", () => {
		const groups = groupFeatures([
			{ calls: 2, cost_micro_eur: 300, operation: "conversations.chunk" },
			{ calls: 1, cost_micro_eur: 100, operation: "" },
		]);
		expect(groups.map((g) => [g.group, g.label, g.calls])).toEqual([
			["other", "Other", 3],
		]);
		expect(groups[0]?.operations.map((o) => [o.operation, o.label])).toEqual([
			["conversations.chunk", "conversations.chunk"],
			["", "Unlabelled"],
		]);
	});
});

describe("providerName", () => {
	it("names the providers staff check invoices against", () => {
		expect(providerName("vertex")).toBe("Google Vertex");
		expect(providerName("openai-compatible")).toBe("Scaleway");
		expect(providerName("fake")).toBe("Test");
		expect(providerName("unknown")).toBe("Unknown");
	});

	it("keeps any other provider as recorded", () => {
		expect(providerName("anthropic")).toBe("anthropic");
	});
});
