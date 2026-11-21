// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	Providers,
	setUpDom,
} from "@/components/project/setup-suggestions/testing";
import { TEMPLATE_SUMMARIES } from "../projectTemplates.fixture";
import { TemplateRow } from "./TemplateRow";

beforeAll(setUpDom);
afterEach(cleanup);

const renderRow = (props: Partial<ComponentProps<typeof TemplateRow>> = {}) => {
	const onChoose = vi.fn();
	const onSeeAll = vi.fn();
	render(
		<Providers>
			<TemplateRow
				templates={TEMPLATE_SUMMARIES}
				onChoose={onChoose}
				onSeeAll={onSeeAll}
				{...props}
			/>
		</Providers>,
	);
	return { onChoose, onSeeAll };
};

const cards = () =>
	screen
		.getByTestId("template-row-list")
		.querySelectorAll<HTMLButtonElement>("button[data-testid^=template-card-]");

describe("TemplateRow", () => {
	it("holds all sixteen cards in one row, the most used first", () => {
		renderRow();
		const list = [...cards()].map((c) => c.dataset.testid);
		expect(list).toHaveLength(16);
		expect(list[0]).toBe("template-card-resident_evening");
		expect(list[6]).toBe("template-card-round_table");
		expect(
			screen.getByRole("region", { name: "Or start from a format" }),
		).toBeTruthy();
	});

	it("chooses a card in one press, with what the row knew", () => {
		const { onChoose } = renderRow();
		fireEvent.click(screen.getByTestId("template-card-world_cafe"));
		expect(onChoose).toHaveBeenCalledWith("world_cafe", {
			featured: false,
			filtersActive: [],
			list: "row",
			setup: "many_groups",
			verbs: ["explore", "understand"],
		});
	});

	it("is one tab stop; the arrow keys, Home and End move along it", () => {
		renderRow();
		const all = cards();
		expect([...all].filter((c) => c.tabIndex === 0)).toHaveLength(1);
		all[0]?.focus();
		fireEvent.keyDown(all[0] as HTMLElement, { key: "ArrowRight" });
		expect(document.activeElement).toBe(all[1]);
		expect(all[1]?.tabIndex).toBe(0);
		fireEvent.keyDown(all[1] as HTMLElement, { key: "End" });
		expect(document.activeElement).toBe(all[15]);
		fireEvent.keyDown(all[15] as HTMLElement, { key: "ArrowRight" });
		expect(document.activeElement).toBe(all[15]);
		fireEvent.keyDown(all[15] as HTMLElement, { key: "Home" });
		expect(document.activeElement).toBe(all[0]);
	});

	it("names its scroll buttons and the way to all formats", () => {
		const { onSeeAll } = renderRow();
		expect(
			screen.getByRole("button", { name: "Earlier formats" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "More formats" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "See all formats" }));
		expect(onSeeAll).toHaveBeenCalled();
	});

	it("waits while the templates load, and keeps all formats when they fail", () => {
		renderRow({ templates: undefined });
		expect(screen.queryByTestId("template-row-list")).toBeNull();
		cleanup();
		renderRow({ failed: true, templates: undefined });
		expect(screen.getByTestId("template-row-see-all")).toBeTruthy();
	});
});
