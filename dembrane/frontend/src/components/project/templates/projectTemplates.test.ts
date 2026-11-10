import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CARD_KEYS,
	isTemplateKey,
	MAX_FACTS,
	NO_FILTER,
	type TemplateSummary,
	templateFacts,
	templateGreatFor,
	visibleCards,
} from "./projectTemplates";
import {
	TEMPLATE_SUMMARIES,
	TEMPLATE_SUMMARIES_NL,
} from "./projectTemplates.fixture";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

const byKey = (key: string) =>
	TEMPLATE_SUMMARIES.find((s) => s.key === key) as TemplateSummary;
const facts = (key: string) => templateFacts(byKey(key));
const keys = (list: TemplateSummary[]) => list.map((s) => s.key);

describe("what a template card says", () => {
	it("has a name, a Great for line and two or three facts for every card", () => {
		for (const key of CARD_KEYS) {
			expect(templateGreatFor(key)).toMatch(/^Great for /);
			const f = facts(key);
			expect([key, f.length >= 2 && f.length <= MAX_FACTS]).toEqual([
				key,
				true,
			]);
		}
	});

	it("says what a resident evening sets up, Verify first", () => {
		expect(facts("resident_evening")).toEqual([
			"Each table checks its own summary",
			"Asks a question when the group gets stuck",
			"Rounds as tags",
		]);
	});

	it("names the What if questions and the other groups for an ideation workshop", () => {
		expect(facts("ideation")).toEqual([
			"Saves the ideas worth keeping",
			'Offers "What if" questions when ideas run out',
			"Can bring in what other groups said",
		]);
	});

	it("says what the name box asks for, in the project's language", () => {
		expect(facts("interviews")).toContain(
			"Asks for “Interview code (no real names)” first",
		);
		const nl = TEMPLATE_SUMMARIES_NL.find((s) => s.key === "working_group");
		expect(templateFacts(nl as TemplateSummary)).toContain(
			"Asks for “Naam of datum van het overleg” first",
		);
	});

	it("never says an upload asks for a session name", () => {
		const f = facts("upload");
		expect(f[0]).toBe("Opens on the upload page");
		expect(f.join(" ")).not.toMatch(/name/i);
	});

	it("knows its keys, old ones included", () => {
		expect(isTemplateKey("resident_evening")).toBe(true);
		expect(isTemplateKey("event")).toBe(true);
		expect(isTemplateKey("festival")).toBe(false);
		expect(isTemplateKey(undefined)).toBe(false);
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
