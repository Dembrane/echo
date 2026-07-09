import { describe, expect, it } from "vitest";
import { parseInsightNote, type ToolActivity } from "./agenticToolActivity";

const baseActivity = (
	overrides: Partial<ToolActivity> = {},
): ToolActivity => ({
	endSeq: 2,
	headline: "Noting this for the dembrane team",
	id: "tool-noteInsight-call-1",
	rawError: null,
	rawInput: null,
	rawOutput: null,
	sortSeq: 2,
	startSeq: 1,
	status: "completed",
	timestamp: "2026-07-09T00:00:00Z",
	toolName: "noteInsight",
	...overrides,
});

const insightOutput = (kind = "wish") =>
	JSON.stringify({
		agent_insight_id: "insight-1",
		content: "The host wants chat to open a specific dashboard tab.",
		insight_kind: kind,
		recorded: true,
		suggested_capability: "Dashboard navigation with internal tab links.",
		type: "agent_insight_note",
		visible_to_user: true,
	});

describe("parseInsightNote", () => {
	it("parses a noteInsight tool output into a structured note", () => {
		const note = parseInsightNote(
			baseActivity({ rawOutput: insightOutput() }),
		);
		expect(note).toEqual({
			content: "The host wants chat to open a specific dashboard tab.",
			kind: "wish",
			suggestedCapability: "Dashboard navigation with internal tab links.",
		});
	});

	it("still renders the card for the legacy recordInsight tool name", () => {
		const note = parseInsightNote(
			baseActivity({
				rawOutput: insightOutput("friction"),
				toolName: "recordInsight",
			}),
		);
		expect(note?.kind).toBe("friction");
		expect(note?.content).toBe(
			"The host wants chat to open a specific dashboard tab.",
		);
	});

	it("returns null for an unrelated tool", () => {
		expect(
			parseInsightNote(
				baseActivity({ rawOutput: insightOutput(), toolName: "navigateTo" }),
			),
		).toBeNull();
	});

	it("returns null when the kind is not a known insight kind", () => {
		expect(
			parseInsightNote(baseActivity({ rawOutput: insightOutput("nonsense") })),
		).toBeNull();
	});

	it("returns null and never throws on a malformed payload", () => {
		expect(
			parseInsightNote(baseActivity({ rawOutput: "{not json" })),
		).toBeNull();
	});

	it("returns null while the note is still running", () => {
		expect(
			parseInsightNote(
				baseActivity({ rawOutput: insightOutput(), status: "running" }),
			),
		).toBeNull();
	});

	it("treats a blank suggested capability as absent", () => {
		const rawOutput = JSON.stringify({
			content: "The host wishes tags were editable from chat.",
			insight_kind: "wish",
			suggested_capability: "   ",
			type: "agent_insight_note",
		});
		const note = parseInsightNote(baseActivity({ rawOutput }));
		expect(note?.suggestedCapability).toBeNull();
	});
});
