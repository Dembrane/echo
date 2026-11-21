// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TemplateSummary } from "../projectTemplates";
import {
	TEMPLATE_SUMMARIES,
	TEMPLATE_SUMMARIES_NL,
} from "../projectTemplates.fixture";
import { TemplateSetupSummary } from "./TemplateSetupSummary";

afterEach(cleanup);
beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia ||= ((query: string) =>
		({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}) as unknown as MediaQueryList) as typeof window.matchMedia;
});

const find = (list: TemplateSummary[], key: string) =>
	list.find((s) => s.key === key) as TemplateSummary;

const renderSummary = (template: TemplateSummary, defaultOpened = false) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<TemplateSetupSummary
					template={template}
					defaultOpened={defaultOpened}
				/>
			</MantineProvider>
		</I18nProvider>,
	);

describe("TemplateSetupSummary", () => {
	it("starts collapsed behind one button", () => {
		renderSummary(find(TEMPLATE_SUMMARIES, "resident_evening"));
		const toggle = screen.getByTestId("template-setup-summary-toggle");
		expect(toggle.textContent).toBe("What this sets up");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
	});

	it("lists the settings and the host script for a resident evening", () => {
		renderSummary(find(TEMPLATE_SUMMARIES, "resident_evening"), true);
		const text =
			screen.getByTestId("template-setup-summary-panel").textContent ?? "";
		for (const part of [
			"Table check",
			"reminded before finishing",
			"On, one question",
			"reads this conversation only",
			"Table name or number",
			"Round 1, Round 2",
			"Tips and best practices",
		])
			expect([part, text.includes(part)]).toEqual([part, true]);
		expect(
			screen.getByTestId("template-setup-summary-script").textContent,
		).toBe("Hosting a table at a resident evening");
	});

	it("says the participant-facing words in the project's language", () => {
		renderSummary(find(TEMPLATE_SUMMARIES_NL, "strategy_day"), true);
		const text =
			screen.getByTestId("template-setup-summary-panel").textContent ?? "";
		expect(text).toContain("Ochtend, Middag");
		expect(text).toContain("Naam van je groep");
		expect(
			screen.getByTestId("template-setup-summary-script").textContent,
		).toBe("Een groep leiden op de heidag");
	});

	it("says when Explore can bring in other groups, and when nothing is asked", () => {
		renderSummary(find(TEMPLATE_SUMMARIES, "ideation"), true);
		expect(
			screen.getByTestId("template-setup-summary-panel").textContent,
		).toContain('On, "What if" questions · can bring in other groups');
		cleanup();
		renderSummary(find(TEMPLATE_SUMMARIES, "kitchen_table"), true);
		const text =
			screen.getByTestId("template-setup-summary-panel").textContent ?? "";
		expect(text).toContain("None: nothing to fill in");
		expect(text).toContain("What we heard, Decisions and actions");
	});
});
