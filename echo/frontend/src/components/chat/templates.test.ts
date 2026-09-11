import { i18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

// The template titles resolve on import, so the locale has to exist first.
i18n.load("en", {});
i18n.activate("en");

const {
	agenticDefaultTemplates,
	agenticQuickAccessTemplates,
	narrativesTemplates,
	Templates,
} = await import("./templates");

describe("narratives templates", () => {
	it("are two entries, one per language, both in the agentic list", () => {
		expect(narrativesTemplates.map((template) => template.id)).toEqual([
			"narratives",
			"narratives-nl",
		]);
		expect(narrativesTemplates[0].content).not.toMatch(/dutch version/i);
		expect(narrativesTemplates[1].content).toMatch(/^Gebruik/);
		for (const template of narrativesTemplates) {
			expect(agenticQuickAccessTemplates).toContain(template);
		}
		const ids = [...Templates, ...agenticQuickAccessTemplates].map(
			(template) => template.id,
		);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("pins the one in the interface language by default", () => {
		const english = agenticDefaultTemplates("en-US").map((t) => t.id);
		const dutch = agenticDefaultTemplates("nl-NL").map((t) => t.id);
		expect(english).toContain("narratives");
		expect(english).not.toContain("narratives-nl");
		expect(dutch).toContain("narratives-nl");
		expect(dutch).not.toContain("narratives");
		expect(english).toHaveLength(4);
		expect(dutch).toHaveLength(4);
	});
});
