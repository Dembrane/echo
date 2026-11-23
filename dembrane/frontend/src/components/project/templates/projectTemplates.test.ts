import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CARD_KEYS,
	cardFacts,
	cardLine,
	cardTags,
	isTemplateKey,
	NO_FILTER,
	offeredCards,
	QUICK_START_CARD,
	rowCards,
	type TemplateSummary,
	templateGreatFor,
	templateName,
	visibleCards,
	withQuickStart,
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
			"One recording at a time",
		]);
	});

	it("knows its keys, old ones included", () => {
		expect(isTemplateKey("resident_evening")).toBe(true);
		expect(isTemplateKey("event")).toBe(true);
		expect(isTemplateKey("blank")).toBe(true);
		expect(isTemplateKey("festival")).toBe(false);
		expect(isTemplateKey(undefined)).toBe(false);
	});
});

describe("Quick start, the plain project", () => {
	it("is the blank template, named as its card says it, with its own line and no tags", () => {
		expect(QUICK_START_CARD.key).toBe("blank");
		expect(templateName("blank")).toBe("Quick start");
		expect(cardLine("blank")).toBe(
			"A plain project. Nothing is set up for you, and you can change every setting later.",
		);
		expect(cardLine("interviews")).toBe(templateGreatFor("interviews"));
		expect(cardTags(QUICK_START_CARD)).toEqual([]);
		// The list's own blank (a link with a setup) has no tags either.
		expect(cardTags(byKey("blank"))).toEqual([]);
		expect(CARD_KEYS.map(templateName)).not.toContain("Quick start");
	});

	it("comes first, before the formats given, and only once", () => {
		const list = withQuickStart(TEMPLATE_SUMMARIES);
		expect(list[0]).toBe(QUICK_START_CARD);
		expect(keys(list.slice(1) as TemplateSummary[])).toEqual([...CARD_KEYS]);
		expect(withQuickStart([])).toEqual([QUICK_START_CARD]);
	});

	it("leads a list with no filter on, and steps aside under a filter unless nothing fits", () => {
		const all = visibleCards(TEMPLATE_SUMMARIES, NO_FILTER);
		const none = offeredCards(all, NO_FILTER);
		expect(none.cards[0]).toBe(QUICK_START_CARD);
		expect(none.count).toBe(17);
		const decide = { setup: null, verb: "decide" } as const;
		const some = offeredCards(visibleCards(TEMPLATE_SUMMARIES, decide), decide);
		expect(keys(some.cards as TemplateSummary[])).toEqual([
			"resident_evening",
			"working_group",
			"citizens_assembly",
		]);
		expect(some.count).toBe(3);
		expect(offeredCards([], decide)).toEqual({
			cards: [QUICK_START_CARD],
			count: 0,
		});
	});

	it("is not featured and sets nothing up, for analytics", () => {
		expect(cardFacts(QUICK_START_CARD)).toEqual({
			featured: false,
			setup: null,
			verbs: [],
		});
		const evening = withQuickStart([byKey("resident_evening")])[1];
		expect(evening && cardFacts(evening)).toEqual({
			featured: true,
			setup: "many_groups",
			verbs: ["understand", "decide"],
		});
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
	it("shows every card, never the old logistic ones or the links", () => {
		const all = visibleCards(TEMPLATE_SUMMARIES, NO_FILTER);
		expect(keys(all)).toEqual([...CARD_KEYS]);
	});

	it("filters by verb from all cards", () => {
		const decide = visibleCards(TEMPLATE_SUMMARIES, {
			setup: null,
			verb: "decide",
		});
		expect(keys(decide)).toEqual([
			"resident_evening",
			"working_group",
			"citizens_assembly",
		]);
	});

	it("combines a verb and a setup", () => {
		const list = visibleCards(TEMPLATE_SUMMARIES, {
			setup: "many_groups",
			verb: "understand",
		});
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
				visibleCards(TEMPLATE_SUMMARIES, { setup: null, verb }).length,
			).toBeGreaterThanOrEqual(2);
	});
});
