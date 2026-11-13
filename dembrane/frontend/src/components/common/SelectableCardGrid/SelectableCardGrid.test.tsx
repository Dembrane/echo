// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SelectableCardGrid } from "./SelectableCardGrid";

afterEach(cleanup);
beforeAll(() => {
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

const options = ["one", "two", "three"].map((value) => ({
	render: (checked: boolean) => (
		<span>
			{value}
			{checked ? " (chosen)" : ""}
		</span>
	),
	testId: `card-${value}`,
	value,
}));

const Harness = ({
	initial = null,
	onChange = () => {},
}: {
	initial?: string | null;
	onChange?: (v: string) => void;
}) => {
	const [value, setValue] = useState<string | null>(initial);
	return (
		<MantineProvider>
			<h2 id="grid-label">Pick one</h2>
			<SelectableCardGrid
				options={options}
				value={value}
				onChange={(v) => {
					setValue(v);
					onChange(v);
				}}
				labelId="grid-label"
				name="harness"
				testId="grid"
			/>
		</MantineProvider>
	);
};

const radios = () => screen.getAllByRole("radio");

describe("SelectableCardGrid", () => {
	it("is a radio group named by its heading, one radio per card", () => {
		render(<Harness />);
		const group = screen.getByRole("radiogroup", { name: "Pick one" });
		expect(group).toBeTruthy();
		expect(radios()).toHaveLength(3);
		expect(
			radios().every((r) => r.getAttribute("aria-checked") === "false"),
		).toBe(true);
	});

	it("has one tab stop: the first card until one is chosen, then the chosen one", () => {
		const { unmount } = render(<Harness />);
		expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
		unmount();
		render(<Harness initial="two" />);
		expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
	});

	it("chooses a card on click and marks it checked and selected", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		fireEvent.click(screen.getByTestId("card-two"));
		expect(onChange).toHaveBeenCalledWith("two");
		const two = screen.getByTestId("card-two");
		expect(two.getAttribute("aria-checked")).toBe("true");
		expect(two.hasAttribute("data-selected")).toBe(true);
		expect(two.textContent).toContain("(chosen)");
		expect(screen.getByTestId("card-one").hasAttribute("data-selected")).toBe(
			false,
		);
	});

	it("moves and chooses with the arrow keys, wrapping at the ends", () => {
		const onChange = vi.fn();
		render(<Harness initial="one" onChange={onChange} />);
		const [one] = radios();
		one?.focus();
		fireEvent.keyDown(one as HTMLElement, {
			code: "ArrowRight",
			key: "ArrowRight",
		});
		expect(onChange).toHaveBeenLastCalledWith("two");
		expect(document.activeElement).toBe(screen.getByTestId("card-two"));
		fireEvent.keyDown(screen.getByTestId("card-two"), {
			code: "ArrowDown",
			key: "ArrowDown",
		});
		expect(onChange).toHaveBeenLastCalledWith("three");
		fireEvent.keyDown(screen.getByTestId("card-three"), {
			code: "ArrowDown",
			key: "ArrowDown",
		});
		expect(onChange).toHaveBeenLastCalledWith("one");
		fireEvent.keyDown(screen.getByTestId("card-one"), {
			code: "ArrowUp",
			key: "ArrowUp",
		});
		expect(onChange).toHaveBeenLastCalledWith("three");
		expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
	});

	it("is a native button, so Space and Enter choose the focused card", () => {
		render(<Harness />);
		for (const r of radios()) expect(r.tagName).toBe("BUTTON");
	});
});
