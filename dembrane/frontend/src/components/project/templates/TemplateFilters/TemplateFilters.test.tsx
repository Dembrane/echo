// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NO_FILTER } from "../projectTemplates";
import { TemplateFilters } from "./TemplateFilters";

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

const renderFilters = (
	props: Partial<Parameters<typeof TemplateFilters>[0]> = {},
) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<TemplateFilters
					value={NO_FILTER}
					onChange={() => {}}
					showAll={{ on: false, onChange: () => {} }}
					count={6}
					{...props}
				/>
			</MantineProvider>
		</I18nProvider>,
	);

describe("TemplateFilters", () => {
	it("offers the five verbs and the two setups as toggle buttons in labelled groups", () => {
		renderFilters();
		const verbs = screen.getByRole("group", {
			name: "What do you need to do?",
		});
		expect(
			[...verbs.querySelectorAll("button")].map((b) => b.textContent),
		).toEqual([
			"GatherGathering expert knowledge",
			"UnderstandUnderstanding what people think",
			"ExploreExploring futures and possibilities",
			"AlignAligning and moving forward",
			"DecideDeciding together",
		]);
		const setup = screen.getByRole("group", { name: "How is it recorded?" });
		expect(setup.querySelectorAll("button[aria-pressed]")).toHaveLength(2);
	});

	it("gives each verb the use-cases page's wording as its description", () => {
		renderFilters();
		const gather = screen.getByTestId("template-filter-verb-gather");
		const id = gather.getAttribute("aria-describedby") as string;
		expect(document.getElementById(id)?.textContent).toBe(
			"Gathering expert knowledge",
		);
	});

	it("presses one verb at a time, and clears it on a second press", () => {
		const onChange = vi.fn();
		const view = renderFilters({ onChange });
		fireEvent.click(screen.getByTestId("template-filter-verb-align"));
		expect(onChange).toHaveBeenLastCalledWith(
			{ setup: null, verb: "align" },
			"verb",
		);
		view.unmount();
		renderFilters({
			onChange,
			value: { setup: "one_recording", verb: "align" },
		});
		expect(
			screen
				.getByTestId("template-filter-verb-align")
				.getAttribute("aria-pressed"),
		).toBe("true");
		fireEvent.click(screen.getByTestId("template-filter-verb-align"));
		expect(onChange).toHaveBeenLastCalledWith(
			{ setup: "one_recording", verb: null },
			"verb",
		);
	});

	it("counts the cards politely once the host filters", () => {
		renderFilters({ count: 1, value: { setup: null, verb: "decide" } });
		const count = screen.getByTestId("template-filter-count");
		expect(count.textContent).toBe("1 template");
		expect(count.getAttribute("aria-live")).toBe("polite");
	});

	it("without a Show all toggle, every card shows and only the count is said", () => {
		renderFilters({ count: 16, showAll: undefined });
		expect(screen.queryByTestId("template-filter-show-all")).toBeNull();
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"16 templates",
		);
	});
});
