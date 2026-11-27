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
				selected="blank"
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
	it("holds Quick start, then all sixteen formats in one bar, the most used first", () => {
		renderRow();
		const list = [...cards()].map((c) => c.dataset.testid);
		expect(list).toHaveLength(17);
		expect(list[0]).toBe("template-card-blank");
		expect(list[1]).toBe("template-card-resident_evening");
		expect(list[7]).toBe("template-card-round_table");
		const quick = screen.getByTestId("template-card-blank");
		// A small card: the room and its name. What it is for is its description.
		expect(quick.textContent).toBe("Quick start");
		expect(quick.title).toBe(
			"A plain project. Nothing is set up for you, and you can change every setting later.",
		);
		expect(
			screen
				.getByTestId("template-row-list")
				.querySelector("[data-testid=template-card-tags]"),
		).toBeNull();
		expect(
			screen.getByRole("region", { name: "Start from a template" }),
		).toBeTruthy();
	});

	it("draws the chosen template pressed, and gives it the tab stop", () => {
		renderRow({ selected: "world_cafe" });
		const pressed = [...cards()].filter(
			(c) => c.getAttribute("aria-pressed") === "true",
		);
		expect(pressed.map((c) => c.dataset.testid)).toEqual([
			"template-card-world_cafe",
		]);
		expect(pressed[0]?.hasAttribute("data-selected")).toBe(true);
		expect(pressed[0]?.tabIndex).toBe(0);
	});

	it("leaves no card chosen for a template it has no card for", () => {
		renderRow({ selected: "upload" });
		expect(
			[...cards()].filter((c) => c.getAttribute("aria-pressed") === "true"),
		).toHaveLength(0);
		expect([...cards()].filter((c) => c.tabIndex === 0)).toHaveLength(1);
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

	it("chooses Quick start as a plain project: not featured, no verbs, no setup", () => {
		const { onChoose } = renderRow();
		fireEvent.click(screen.getByTestId("template-card-blank"));
		expect(onChoose).toHaveBeenCalledWith("blank", {
			featured: false,
			filtersActive: [],
			list: "row",
			setup: null,
			verbs: [],
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
		expect(document.activeElement).toBe(all[16]);
		fireEvent.keyDown(all[16] as HTMLElement, { key: "ArrowRight" });
		expect(document.activeElement).toBe(all[16]);
		fireEvent.keyDown(all[16] as HTMLElement, { key: "Home" });
		expect(document.activeElement).toBe(all[0]);
	});

	it("keeps one tab stop when the row shrinks under the focus", () => {
		const props = {
			onChoose: vi.fn(),
			onSeeAll: vi.fn(),
			selected: "blank" as const,
		};
		const view = render(
			<Providers>
				<TemplateRow templates={TEMPLATE_SUMMARIES} {...props} />
			</Providers>,
		);
		const all = cards();
		all[0]?.focus();
		fireEvent.keyDown(all[0] as HTMLElement, { key: "End" });
		expect(cards()[16]?.tabIndex).toBe(0);
		// A refetch that fails leaves Quick start alone.
		view.rerender(
			<Providers>
				<TemplateRow templates={undefined} failed {...props} />
			</Providers>,
		);
		const left = cards();
		expect(left).toHaveLength(1);
		expect(left[0]?.tabIndex).toBe(0);
	});

	it("names its scroll buttons and the way to all formats", () => {
		const { onSeeAll } = renderRow();
		expect(
			screen.getByRole("button", { name: "Earlier templates" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "More templates" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "See all templates" }));
		expect(onSeeAll).toHaveBeenCalled();
	});

	it("waits while the templates load, with no card yet", () => {
		renderRow({ templates: undefined });
		expect(screen.queryByTestId("template-row-list")).toBeNull();
		expect(screen.queryByTestId("template-card-blank")).toBeNull();
		expect(
			screen.getByTestId("template-row").querySelector("[aria-busy=true]"),
		).toBeTruthy();
	});

	it("offers Quick start alone when the templates fail, and keeps all formats", () => {
		const { onChoose } = renderRow({ failed: true, templates: undefined });
		expect([...cards()].map((c) => c.dataset.testid)).toEqual([
			"template-card-blank",
		]);
		expect(screen.getByTestId("template-row-see-all")).toBeTruthy();
		// One card has nowhere to scroll.
		expect(screen.queryByRole("button", { name: "More templates" })).toBeNull();
		fireEvent.click(screen.getByTestId("template-card-blank"));
		expect(onChoose).toHaveBeenCalledWith("blank", expect.anything());
	});
});
