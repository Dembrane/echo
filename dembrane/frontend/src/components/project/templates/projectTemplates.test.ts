import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CARD_KEYS,
	cardTags,
	isTemplateKey,
	NO_FILTER,
	rowCards,
	type TemplateSummary,
	templateGreatFor,
	templateName,
	visibleCards,
} from "./projectTemplates";
import { TEMPLATE_SUMMARIES } from "./projectTemplates.fixture";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

const byKey = (key: string) =>
	TEMPLATE_SUMMARIES.find((s) => s.key === key) as TemplateSummary;
const keys = (list: TemplateSummary[]) => list.map((s) => s.key);

describe("what a template card says", () => {
	it("has a name and a one-line Great for for every card, each name different", () => {
		const names = CARD_KEYS.map(templateName);
		expect(new Set(names).size).toBe(CARD_KEYS.length);
		for (const key of CARD_KEYS) {
			expect(templateGreatFor(key)).toMatch(/^Great for [^.]+\.$/);
			expect(templateGreatFor(key).length).toBeLessThanOrEqual(100);
		}
	});

	it("names formats, not occasions: occasions are in the Great for line", () => {
		expect(templateName("resident_evening")).toBe("Table conversations");
		expect(templateGreatFor("resident_evening")).toContain("resident evenings");
		expect(templateName("strategy_day")).toBe("Strategy session");
		expect(templateName("conference")).toBe("Parallel sessions");
		expect(templateGreatFor("conference")).toContain("conferences");
	});

	it("tags a card with its named method first, then its verbs and its setup", () => {
		expect(cardTags(byKey("world_cafe"))).toEqual([
			"World Café",
			"Explore",
			"Understand",
			"Many groups at once",
		]);
		expect(cardTags(byKey("interviews"))).toEqual([
			"Understand",
			"Gather",
			"One recording",
		]);
	});

	it("knows its keys, old ones included", () => {
		expect(isTemplateKey("resident_evening")).toBe(true);
		expect(isTemplateKey("event")).toBe(true);
		expect(isTemplateKey("festival")).toBe(false);
		expect(isTemplateKey(undefined)).toBe(false);
	});
});

describe("the start screen's row", () => {
	it("holds every card once, the most used first", () => {
		const row = keys(rowCards(TEMPLATE_SUMMARIES));
		expect(row.slice(0, 6)).toEqual([
			"resident_evening",
			"focus_group",
			"interviews",
			"strategy_day",
			"working_group",
			"ideation",
		]);
		expect([...row].sort()).toEqual([...CARD_KEYS].sort());
	});
});

describe("which cards show", () => {
	it("starts with the short most used set, in both setups", () => {
		const first = visibleCards(TEMPLATE_SUMMARIES, NO_FILTER, false);
		expect(keys(first)).toEqual([
			"resident_evening",
			"focus_group",
			"interviews",
			"strategy_day",
			"working_group",
			"ideation",
		]);
		expect(new Set(first.map((s) => s.card.setup)).size).toBe(2);
	});

	it("shows every card, never the old logistic ones or the links", () => {
		const all = visibleCards(TEMPLATE_SUMMARIES, NO_FILTER, true);
		expect(keys(all)).toEqual([...CARD_KEYS]);
	});

	it("filters by verb from all cards, not only the most used", () => {
		const decide = visibleCards(
			TEMPLATE_SUMMARIES,
			{ setup: null, verb: "decide" },
			false,
		);
		expect(keys(decide)).toEqual([
			"resident_evening",
			"working_group",
			"citizens_assembly",
		]);
	});

	it("combines a verb and a setup", () => {
		const list = visibleCards(
			TEMPLATE_SUMMARIES,
			{ setup: "many_groups", verb: "understand" },
			false,
		);
		expect(keys(list)).toEqual([
			"resident_evening",
			"world_cafe",
			"conversation_cafe",
		]);
	});

	it("every verb finds at least two cards", () => {
		for (const verb of [
			"gather",
			"understand",
			"explore",
			"align",
			"decide",
		] as const)
			expect(
				visibleCards(TEMPLATE_SUMMARIES, { setup: null, verb }, false).length,
			).toBeGreaterThanOrEqual(2);
	});
});
