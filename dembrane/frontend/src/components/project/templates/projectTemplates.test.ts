import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	isTemplateKey,
	MAX_FACTS,
	type TemplateSummary,
	templateFacts,
} from "./projectTemplates";
import { TEMPLATE_SUMMARIES } from "./projectTemplates.fixture";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

const facts = (key: string) =>
	templateFacts(TEMPLATE_SUMMARIES.find((s) => s.key === key) as never);

describe("what a template card says it sets up", () => {
	it("comes from the summary, two or three facts for every card", () => {
		for (const key of ["conversation", "series", "event", "upload"]) {
			const f = facts(key);
			expect(f.length).toBeGreaterThanOrEqual(2);
			expect(f.length).toBeLessThanOrEqual(MAX_FACTS);
		}
	});

	it("puts the table name and Verify first for an event", () => {
		expect(facts("event")).toEqual([
			"Asks each table for its name",
			"Tables check and approve their own outcome (Verify)",
			"Participants can ask for a question to go deeper (Explore)",
		]);
	});

	it("says a single conversation needs nothing filled in and gets a title", () => {
		expect(facts("conversation")).toEqual([
			"Gives each conversation a title",
			"Nothing to fill in before recording",
		]);
	});

	it("opens on upload for existing recordings", () => {
		expect(facts("upload")[0]).toBe("Opens on the upload page");
	});

	it("follows the data, not the key", () => {
		const base = TEMPLATE_SUMMARIES[0] as TemplateSummary;
		const custom: TemplateSummary = {
			...base,
			summary: {
				...base.summary,
				asks_for_name: true,
				auto_titles: false,
				tag_count: 1,
			},
		};
		expect(templateFacts(custom)).toEqual([
			"Adds 1 tag to pick when recording starts",
			"Asks for a session name before recording",
		]);
	});

	it("knows its keys", () => {
		expect(isTemplateKey("event")).toBe(true);
		expect(isTemplateKey("festival")).toBe(false);
		expect(isTemplateKey(undefined)).toBe(false);
	});
});
