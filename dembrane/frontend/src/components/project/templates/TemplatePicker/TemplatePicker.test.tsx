// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEMPLATE_SUMMARIES } from "../projectTemplates.fixture";
import { TemplatePicker } from "./TemplatePicker";

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

const renderPicker = (
	props: Partial<ComponentProps<typeof TemplatePicker>> = {},
) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<TemplatePicker
					templates={TEMPLATE_SUMMARIES}
					value={null}
					onChange={() => {}}
					{...props}
				/>
			</MantineProvider>
		</I18nProvider>,
	);

const cards = () =>
	screen.getAllByRole("radio").map((r) => r.getAttribute("data-testid"));

describe("TemplatePicker", () => {
	it("asks what the host is going to do and shows Quick start, then the most used cards", () => {
		renderPicker();
		expect(
			screen.getByRole("radiogroup", { name: "What are you going to do?" }),
		).toBeTruthy();
		expect(cards()).toEqual([
			"template-card-blank",
			"template-card-resident_evening",
			"template-card-focus_group",
			"template-card-interviews",
			"template-card-strategy_day",
			"template-card-working_group",
			"template-card-ideation",
		]);
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"Most used. Filter to find more.",
		);
	});

	it("filters by verb from all cards, as pressed toggle buttons, and says how many", () => {
		const onFilterChange = vi.fn();
		renderPicker({ onFilterChange });
		const decide = screen.getByTestId("template-filter-verb-decide");
		expect(decide.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(decide);
		expect(decide.getAttribute("aria-pressed")).toBe("true");
		// Only the formats that match: Quick start matches no filter.
		expect(cards()).toEqual([
			"template-card-resident_evening",
			"template-card-working_group",
			"template-card-citizens_assembly",
		]);
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"3 templates",
		);
		expect(
			screen.getByTestId("template-filter-count").getAttribute("aria-live"),
		).toBe("polite");
		expect(onFilterChange).toHaveBeenLastCalledWith("verb", "decide");
		// Pressing it again clears it.
		fireEvent.click(decide);
		expect(onFilterChange).toHaveBeenLastCalledWith("verb", "none");
		expect(cards()).toHaveLength(7);
	});

	it("filters by setup, and both filters together", () => {
		renderPicker();
		fireEvent.click(screen.getByTestId("template-filter-setup-many_groups"));
		expect(cards()).toHaveLength(10);
		fireEvent.click(screen.getByTestId("template-filter-verb-gather"));
		expect(cards()).toEqual([
			"template-card-open_space",
			"template-card-one_two_four_all",
			"template-card-conference",
		]);
	});

	it("shows Quick start alone when no format fits both filters", () => {
		renderPicker();
		fireEvent.click(screen.getByTestId("template-filter-verb-explore"));
		fireEvent.click(screen.getByTestId("template-filter-setup-one_recording"));
		expect(screen.getByTestId("template-picker-none").textContent).toBe(
			"No template fits both. Clear a filter, or use Quick start.",
		);
		expect(cards()).toEqual(["template-card-blank"]);
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"0 templates",
		);
	});

	it("shows Quick start and all sixteen formats and clears the filters", () => {
		const onFilterChange = vi.fn();
		renderPicker({ onFilterChange });
		fireEvent.click(screen.getByTestId("template-filter-verb-explore"));
		fireEvent.click(screen.getByTestId("template-filter-show-all"));
		expect(cards()).toHaveLength(17);
		expect(cards()[0]).toBe("template-card-blank");
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"17 templates",
		);
		expect(
			screen
				.getByTestId("template-filter-verb-explore")
				.getAttribute("aria-pressed"),
		).toBe("false");
		expect(
			screen
				.getByTestId("template-filter-show-all")
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(onFilterChange).toHaveBeenLastCalledWith("show_all", "on");
	});

	it("hands the chosen key out with what the picker knew, and shows it checked", () => {
		const onChange = vi.fn();
		const view = renderPicker({ onChange });
		fireEvent.click(screen.getByTestId("template-filter-verb-understand"));
		fireEvent.click(screen.getByTestId("template-card-kitchen_table"));
		expect(onChange).toHaveBeenCalledWith("kitchen_table", {
			featured: false,
			filtersActive: ["verb:understand"],
			setup: "one_recording",
			verbs: ["understand"],
		});
		view.unmount();
		renderPicker({ value: "resident_evening" });
		expect(
			screen
				.getByTestId("template-card-resident_evening")
				.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("hands Quick start out as a plain project, and shows it checked", () => {
		const onChange = vi.fn();
		const view = renderPicker({ onChange });
		fireEvent.click(screen.getByTestId("template-filter-show-all"));
		fireEvent.click(screen.getByTestId("template-card-blank"));
		expect(onChange).toHaveBeenCalledWith("blank", {
			featured: false,
			filtersActive: ["show_all"],
			setup: null,
			verbs: [],
		});
		view.unmount();
		renderPicker({ value: "blank" });
		const quick = screen.getByTestId("template-card-blank");
		expect(quick.getAttribute("aria-checked")).toBe("true");
		expect(quick.textContent).toContain("Quick start");
		expect(quick.querySelector("[data-testid=template-card-tags]")).toBeNull();
	});

	it("shows the drawing, Great for and the tags on each card, no feature lines", () => {
		renderPicker();
		const evening = screen.getByTestId("template-card-resident_evening");
		expect(evening.textContent).toContain("Table conversations");
		expect(evening.textContent).toContain("Great for resident");
		expect(evening.textContent).not.toContain("Each table checks");
		expect(
			evening.querySelector(
				"[data-testid=template-illustration-resident_evening]",
			),
		).toBeTruthy();
		const tags = evening.querySelector("[data-testid=template-card-tags]");
		expect(tags?.textContent).toBe("UnderstandDecideMany groups at once");
	});

	it("names the format on a card that follows one", () => {
		renderPicker();
		fireEvent.click(screen.getByTestId("template-filter-show-all"));
		expect(
			screen.getByTestId("template-card-world_cafe").textContent,
		).toContain("World Café");
	});

	it("offers Upload recordings as a quiet link, only when it can be used, and no Start blank", () => {
		const onUpload = vi.fn();
		const view = renderPicker({ onUpload });
		fireEvent.click(screen.getByTestId("template-picker-upload"));
		expect(onUpload).toHaveBeenCalled();
		// A link, not a card; Quick start is the card, so there is no Start blank link.
		expect(cards()).not.toContain("template-card-upload");
		expect(screen.queryByTestId("template-picker-start-blank")).toBeNull();
		view.unmount();
		renderPicker();
		expect(screen.queryByTestId("template-picker-links")).toBeNull();
	});

	it("carries the walkthrough anchor", () => {
		renderPicker();
		expect(
			screen.getByTestId("template-picker").getAttribute("data-tour"),
		).toBe("template-picker");
	});

	it("waits while loading and keeps Quick start when the list fails", () => {
		const view = renderPicker({ templates: undefined });
		expect(screen.queryAllByRole("radio")).toHaveLength(0);
		view.unmount();
		renderPicker({
			failed: true,
			onUpload: () => {},
			templates: undefined,
		});
		expect(screen.getByTestId("template-picker-failed")).toBeTruthy();
		expect(cards()).toEqual(["template-card-blank"]);
		expect(screen.queryByTestId("template-picker-upload")).toBeNull();
	});
});
