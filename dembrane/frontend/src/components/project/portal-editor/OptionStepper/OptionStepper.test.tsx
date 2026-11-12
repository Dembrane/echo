// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OptionStepper, type StepperOption } from "./OptionStepper";

i18n.load("en-US", {});
i18n.activate("en-US");
afterEach(cleanup);
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

const options: StepperOption[] = [
	{
		body: <input aria-label="Title field" />,
		key: "title",
		summary: "Hello",
		title: "Title",
	},
	{ body: <p>text body</p>, key: "text", summary: "Some text", title: "Text" },
	{ body: <p>last body</p>, key: "last", summary: "Off", title: "Last" },
];

const renderStepper = (
	openKey: string | null,
	props: Partial<Parameters<typeof OptionStepper>[0]> = {},
) => {
	const onOpen = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<OptionStepper
					options={options}
					openKey={openKey}
					onOpen={onOpen}
					{...props}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	return onOpen;
};

describe("OptionStepper", () => {
	it("opens one option and shows the others' values in a line", () => {
		renderStepper("text");
		expect(screen.getByTestId("portal-option-text-body").textContent).toContain(
			"text body",
		);
		expect(screen.queryByTestId("portal-option-title-body")).toBeNull();
		expect(screen.getByTestId("portal-option-title-summary").textContent).toBe(
			"Hello",
		);
		expect(screen.queryByTestId("portal-option-text-summary")).toBeNull();
		expect(
			screen
				.getByTestId("portal-option-text-row")
				.getAttribute("aria-expanded"),
		).toBe("true");
		const progress = screen.getByTestId("portal-option-progress");
		expect(progress.getAttribute("aria-valuenow")).toBe("2");
		expect(progress.getAttribute("aria-valuemax")).toBe("3");
	});

	it("opens the first when the address names none of them", () => {
		renderStepper("gone");
		expect(screen.getByTestId("portal-option-title-body")).toBeTruthy();
	});

	it("steps with Next and Back, and opens a row on click", () => {
		const onOpen = renderStepper("text");
		fireEvent.click(screen.getByTestId("portal-option-next"));
		expect(onOpen).toHaveBeenLastCalledWith("last", "next");
		fireEvent.click(screen.getByTestId("portal-option-back"));
		expect(onOpen).toHaveBeenLastCalledWith("title", "back");
		fireEvent.click(screen.getByTestId("portal-option-last-row"));
		expect(onOpen).toHaveBeenLastCalledWith("last", "row");
	});

	it("has no Back on the first option and goes to the next page from the last", () => {
		renderStepper("title");
		expect(screen.queryByTestId("portal-option-back")).toBeNull();
		cleanup();
		const onNextPage = vi.fn();
		renderStepper("last", { nextLabel: "Next: About", onNextPage });
		const next = screen.getByTestId("portal-option-next");
		expect(next.textContent).toBe("Next: About");
		fireEvent.click(next);
		expect(onNextPage).toHaveBeenCalled();
		cleanup();
		renderStepper("last");
		expect(screen.queryByTestId("portal-option-next")).toBeNull();
	});

	it("moves between rows with the arrow keys, Home and End", () => {
		renderStepper("title");
		const first = screen.getByTestId("portal-option-title-row");
		first.focus();
		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(document.activeElement).toBe(
			screen.getByTestId("portal-option-text-row"),
		);
		fireEvent.keyDown(document.activeElement as Element, { key: "End" });
		expect(document.activeElement).toBe(
			screen.getByTestId("portal-option-last-row"),
		);
		fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
		expect(document.activeElement).toBe(first);
	});
});
