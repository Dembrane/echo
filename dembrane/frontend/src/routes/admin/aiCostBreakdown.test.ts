import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	classifyOperation,
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

describe("classifyOperation", () => {
	const cases: [string, string, string][] = [
		// Chat
		["POST /api/chats/:chat_id", "chat", "Replies"],
		["GET /api/chats/:chat_id/suggestions", "chat", "Suggestions"],
		["POST /api/chats/:chat_id/suggestions", "chat", "Suggestions"],
		["POST /api/chats/:chat_id/add-context", "chat", "Chat"],
		["POST /api/v2/bff/chats", "chat", "Chat"],
		// Assistant
		["agentic.turn.run", "assistant", "Assistant turns"],
		["agentic.turn", "assistant", "Assistant turns"],
		["POST /api/agentic/runs", "assistant", "New runs"],
		[
			"POST /api/agentic/runs/:run_id/messages",
			"assistant",
			"Follow-up messages",
		],
		// Reports
		["reports.generate", "reports", "Report generation"],
		["POST /api/projects/:project_id/create-report", "reports", "Reports"],
		// Map
		["map.group", "map", "Groups"],
		["map.fact_check", "map", "Fact checks"],
		["POST /api/v2/bff/map/:project_id/generate", "map", "Map"],
		// Analysis
		["popcorn.tick.manual", "analysis", "Popcorn ticks"],
		["popcorn.tick.scheduled", "analysis", "Popcorn ticks"],
		["popcorn.tick.translation", "analysis", "Popcorn translation"],
		["POST /api/v2/bff/popcorn/loops", "analysis", "Popcorn"],
		["analysis.run", "analysis", "Analysis runs"],
		["POST /api/v2/bff/analysis/runs", "analysis", "Analysis"],
		// Canvas
		["canvas.tick", "canvas", "Canvas ticks"],
		["POST /api/v2/bff/canvases/:id/preview", "canvas", "Canvas"],
		// Portal
		["POST /api/verify/generate", "portal", "Verify"],
		["POST /api/conversations/:conversation_id/get-reply", "portal", "Explore"],
		// Recording
		["conversations.chunk", "recording", "Transcription"],
		["conversations.finish", "recording", "Finishing"],
		["conversations.finalize", "recording", "Finalize and summary"],
		["conversations.final-transcript", "recording", "Final transcript"],
		["conversations.summarize", "recording", "Conversation summaries"],
		[
			"POST /api/conversations/:conversation_id/summarize",
			"recording",
			"Conversation summaries",
		],
		[
			"POST /api/conversations/:conversation_id/generate-title",
			"recording",
			"Titles and tags",
		],
		[
			"POST /api/conversations/:conversation_id/retranscribe",
			"recording",
			"Retranscribe",
		],
		[
			"POST /api/participant/conversations/:conversation_id/upload-text",
			"recording",
			"Recording",
		],
		// Voice input
		["POST /api/stateless/transcribe", "voice", "Voice input"],
	];

	it.each(cases)("%s is %s: %s", (operation, group, label) => {
		expect(classifyOperation(operation)).toEqual({ group, label });
	});

	it("puts anything unknown in Other under its raw key", () => {
		expect(classifyOperation("samples.seed-best-practices")).toEqual({
			group: "other",
			label: "samples.seed-best-practices",
		});
		expect(classifyOperation("GET /api/v2/me")).toEqual({
			group: "other",
			label: "GET /api/v2/me",
		});
		expect(classifyOperation("")).toEqual({
			group: "other",
			label: "Unlabelled",
		});
	});

	it("matches a route by its path, not a lookalike", () => {
		expect(classifyOperation("POST /api/chatsx").group).toBe("other");
		expect(classifyOperation("mapping.thing").group).toBe("other");
	});
});

describe("groupFeatures", () => {
	it("groups operations by feature, with shares, most expensive first", () => {
		const groups = groupFeatures([
			{ calls: 10, cost_micro_eur: 600_000, operation: "conversations.chunk" },
			{
				calls: 3,
				cost_micro_eur: 100_000,
				operation: "POST /api/chats/:chat_id",
			},
			{ calls: 2, cost_micro_eur: 50_000, operation: "conversations.finalize" },
			{
				calls: 5,
				cost_micro_eur: 250_000,
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

	it("keeps calls optional and a zero total at zero shares", () => {
		const groups = groupFeatures([{ cost_micro_eur: 0, operation: "" }]);
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
