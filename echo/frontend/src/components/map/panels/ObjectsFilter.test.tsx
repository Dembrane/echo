// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { zeroTypeCounts } from "../data/scope";
import type { ObjectType } from "../types";
import { ObjectsFilterList } from "./ObjectsFilter";

i18n.load("en-US", {});
i18n.activate("en-US");

beforeAll(() => {
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
});

afterEach(cleanup);

const counts = { ...zeroTypeCounts(), argument: 60, deduplicated_argument: 24 };

const renderList = (
	selected: ObjectType[],
	onChange = vi.fn(),
	onGenerate = vi.fn(),
) =>
	render(
		<MantineProvider>
			<I18nProvider i18n={i18n}>
				<ObjectsFilterList
					counts={counts}
					selected={selected}
					onChange={onChange}
					onGenerate={onGenerate}
				/>
			</I18nProvider>
		</MantineProvider>,
	);

describe("ObjectsFilterList", () => {
	it("lists every type with its count", () => {
		const { container } = renderList(["argument"]);
		const labels = Array.from(container.querySelectorAll("label")).map(
			(label) => label.textContent,
		);
		expect(labels).toEqual([
			"Arguments60",
			"Deduplicated arguments24",
			"Popcorn0",
			"Tensions0",
			"Stakeholders0",
		]);
	});

	it("changes the selection without starting generation", () => {
		const onChange = vi.fn();
		const onGenerate = vi.fn();
		renderList(["argument"], onChange, onGenerate);
		fireEvent.click(screen.getByRole("checkbox", { name: /^Tensions/ }));
		expect(onChange).toHaveBeenCalledWith(["argument", "tension"]);
		fireEvent.click(screen.getByRole("checkbox", { name: /^Arguments/ }));
		expect(onChange).toHaveBeenLastCalledWith([]);
		expect(onGenerate).not.toHaveBeenCalled();
	});

	it("says clearly when a checked type has no saved objects and offers its action", () => {
		const onGenerate = vi.fn();
		renderList(["argument", "tension"], vi.fn(), onGenerate);
		expect(screen.getByText("No tensions saved yet.")).toBeTruthy();
		// A checked type with objects offers nothing.
		expect(screen.queryByText("Generate map")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Generate tensions" }));
		expect(onGenerate).toHaveBeenCalledWith("tension");
	});
});
