// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	Providers,
	setUpDom,
} from "@/components/project/setup-suggestions/testing";
import { TEMPLATE_SUMMARIES } from "../projectTemplates.fixture";
import { AllFormats } from "./AllFormats";

beforeAll(setUpDom);
afterEach(cleanup);

const renderAll = (props: Partial<ComponentProps<typeof AllFormats>> = {}) => {
	const handlers = {
		onChoose: vi.fn(),
		onFilterChange: vi.fn(),
		onStartBlank: vi.fn(),
		onUpload: vi.fn(),
	};
	render(
		<Providers>
			<AllFormats templates={TEMPLATE_SUMMARIES} {...handlers} {...props} />
		</Providers>,
	);
	return handlers;
};

const shown = () =>
	[
		...screen
			.getByTestId("all-formats-grid")
			.querySelectorAll("button[data-testid^=template-card-]"),
	].map((b) => b.getAttribute("data-testid"));

describe("AllFormats", () => {
	it("shows the filters first, then all sixteen cards, without Show all", () => {
		renderAll();
		expect(shown()).toHaveLength(16);
		expect(screen.queryByTestId("template-filter-show-all")).toBeNull();
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"16 templates",
		);
		const filters = screen.getByTestId("template-filters");
		const grid = screen.getByTestId("all-formats-grid");
		expect(
			filters.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("filters, and a press chooses with the filters it was found under", () => {
		const h = renderAll();
		fireEvent.click(screen.getByTestId("template-filter-verb-decide"));
		expect(h.onFilterChange).toHaveBeenCalledWith("verb", "decide");
		expect(shown()).toEqual([
			"template-card-resident_evening",
			"template-card-working_group",
			"template-card-citizens_assembly",
		]);
		fireEvent.click(screen.getByTestId("template-card-citizens_assembly"));
		expect(h.onChoose).toHaveBeenCalledWith("citizens_assembly", {
			featured: false,
			filtersActive: ["verb:decide"],
			list: "all_formats",
			setup: "many_groups",
			verbs: ["decide"],
		});
	});

	it("keeps the quiet ways out: upload recordings and start blank", () => {
		const h = renderAll();
		fireEvent.click(screen.getByTestId("template-picker-upload"));
		fireEvent.click(screen.getByTestId("template-picker-start-blank"));
		expect(h.onUpload).toHaveBeenCalled();
		expect(h.onStartBlank).toHaveBeenCalled();
	});

	it("says when the templates did not load, and still offers blank", () => {
		renderAll({ failed: true, templates: undefined });
		expect(screen.getByTestId("template-picker-failed")).toBeTruthy();
		expect(screen.queryByTestId("template-picker-upload")).toBeNull();
		expect(screen.getByTestId("template-picker-start-blank")).toBeTruthy();
	});
});
