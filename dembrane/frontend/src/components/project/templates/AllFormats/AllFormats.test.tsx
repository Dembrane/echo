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
	it("shows the filters first, then Quick start and all sixteen formats, without Show all", () => {
		renderAll();
		expect(shown()).toHaveLength(17);
		expect(shown()[0]).toBe("template-card-blank");
		expect(screen.queryByTestId("template-filter-show-all")).toBeNull();
		// The count says what is on screen.
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"17 templates",
		);
		const filters = screen.getByTestId("template-filters");
		const grid = screen.getByTestId("all-formats-grid");
		expect(
			filters.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("filters to the matching formats only, and a press chooses with the filters it was found under", () => {
		const h = renderAll();
		fireEvent.click(screen.getByTestId("template-filter-verb-decide"));
		expect(h.onFilterChange).toHaveBeenCalledWith("verb", "decide");
		// Quick start matches no filter: it is not among the results.
		expect(shown()).toEqual([
			"template-card-resident_evening",
			"template-card-working_group",
			"template-card-citizens_assembly",
		]);
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"3 templates",
		);
		fireEvent.click(screen.getByTestId("template-card-citizens_assembly"));
		expect(h.onChoose).toHaveBeenCalledWith("citizens_assembly", {
			featured: false,
			filtersActive: ["verb:decide"],
			list: "all_formats",
			setup: "many_groups",
			verbs: ["decide"],
		});
	});

	it("chooses Quick start as a plain project, and brings it back when the filter is cleared", () => {
		const h = renderAll();
		fireEvent.click(screen.getByTestId("template-filter-setup-many_groups"));
		expect(shown()).not.toContain("template-card-blank");
		fireEvent.click(screen.getByTestId("template-filter-setup-many_groups"));
		expect(shown()[0]).toBe("template-card-blank");
		fireEvent.click(screen.getByTestId("template-card-blank"));
		expect(h.onChoose).toHaveBeenCalledWith("blank", {
			featured: false,
			filtersActive: [],
			list: "all_formats",
			setup: null,
			verbs: [],
		});
	});

	it("shows Quick start alone when no format fits, under the message, so there is a way on", () => {
		renderAll();
		fireEvent.click(screen.getByTestId("template-filter-verb-explore"));
		fireEvent.click(screen.getByTestId("template-filter-setup-one_recording"));
		expect(screen.getByTestId("template-picker-none").textContent).toBe(
			"No template fits both. Clear a filter, or use Quick start.",
		);
		expect(shown()).toEqual(["template-card-blank"]);
		expect(screen.getByTestId("template-filter-count").textContent).toBe(
			"0 templates",
		);
		const grid = screen.getByTestId("all-formats-grid");
		expect(
			screen.getByTestId("template-picker-none").compareDocumentPosition(grid) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("keeps the quiet way out to upload recordings; Quick start is a card, not a link", () => {
		const h = renderAll();
		fireEvent.click(screen.getByTestId("template-picker-upload"));
		expect(h.onUpload).toHaveBeenCalled();
		expect(screen.queryByTestId("template-picker-start-blank")).toBeNull();
		expect(screen.queryByText("Start blank")).toBeNull();
	});

	it("says when the templates did not load, and still offers Quick start under it", () => {
		const h = renderAll({ failed: true, templates: undefined });
		const failed = screen.getByTestId("template-picker-failed");
		expect(failed.textContent).toBe(
			"The templates did not load. You can still use Quick start and set the project up yourself.",
		);
		expect(screen.queryByTestId("template-picker-upload")).toBeNull();
		expect(shown()).toEqual(["template-card-blank"]);
		const grid = screen.getByTestId("all-formats-grid");
		expect(
			failed.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		fireEvent.click(screen.getByTestId("template-card-blank"));
		expect(h.onChoose).toHaveBeenCalledWith("blank", expect.anything());
	});
});
