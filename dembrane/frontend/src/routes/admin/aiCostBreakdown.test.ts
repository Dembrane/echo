import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	formatAiCost,
	formatShare,
	groupFeatures,
	providerName,
} from "./aiCostBreakdown";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

describe("formatAiCost", () => {
	it("shows two decimals from one euro up", () => {
		expect(formatAiCost(1_000_000)).toBe("€1.00");
		expect(formatAiCost(5_000_000)).toBe("€5.00");
		expect(formatAiCost(1_234_567_890)).toBe("€1,234.57");
	});

	it("never shows a non-zero cost as zero", () => {
		expect(formatAiCost(350_000)).toBe("€0.35");
		expect(formatAiCost(500_000)).toBe("€0.50");
		expect(formatAiCost(70_000)).toBe("€0.07");
		expect(formatAiCost(4_000)).toBe("€0.004");
		expect(formatAiCost(35_000)).toBe("€0.035");
		expect(formatAiCost(3_500)).toBe("€0.0035");
		expect(formatAiCost(1_129)).toBe("€0.0011");
		expect(formatAiCost(100)).toBe("€0.0001");
	});

	it("calls dust below a hundredth of a cent dust", () => {
		expect(formatAiCost(99)).toBe("< €0.0001");
		expect(formatAiCost(1)).toBe("< €0.0001");
	});

	it("shows nothing spent as zero", () => {
		expect(formatAiCost(0)).toBe("€0.00");
	});
});

describe("formatShare", () => {
	it("rounds, and never hides a small share as 0%", () => {
		expect(formatShare(0.5)).toBe("50%");
		expect(formatShare(1)).toBe("100%");
		expect(formatShare(0.004)).toBe("<1%");
		expect(formatShare(0)).toBe("0%");
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
						share: 0,
					},
				],
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
