// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InfoTip } from "./InfoTip";

beforeAll(() => {
	window.matchMedia =
		window.matchMedia ||
		(((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		})) as unknown as typeof window.matchMedia);
});

afterEach(cleanup);

const renderTip = () =>
	render(
		<MantineProvider>
			<InfoTip label="About the preview" testId="tip">
				What participants see.
			</InfoTip>
		</MantineProvider>,
	);

const shown = () =>
	(screen.getByTestId("tip-tip") as HTMLElement).style.display !== "none";

describe("InfoTip", () => {
	it("is a named button described by its explanation, even while closed", () => {
		renderTip();
		const button = screen.getByRole("button", { name: "About the preview" });
		const description = document.getElementById(
			button.getAttribute("aria-describedby") ?? "",
		);
		expect(description?.textContent).toBe("What participants see.");
		expect(shown()).toBe(false);
	});

	it("opens on hover and on focus, and closes on leaving, blur and Escape", async () => {
		renderTip();
		const button = screen.getByTestId("tip");
		fireEvent.mouseEnter(button);
		await waitFor(() => expect(shown()).toBe(true));
		fireEvent.mouseLeave(button);
		await waitFor(() => expect(shown()).toBe(false));
		fireEvent.focus(button);
		await waitFor(() => expect(shown()).toBe(true));
		fireEvent.keyDown(button, { key: "Escape" });
		await waitFor(() => expect(shown()).toBe(false));
		fireEvent.focus(button);
		fireEvent.blur(button);
		await waitFor(() => expect(shown()).toBe(false));
	});

	it("toggles on a tap", async () => {
		renderTip();
		const button = screen.getByTestId("tip");
		fireEvent.pointerDown(button, { pointerType: "touch" });
		fireEvent.click(button);
		await waitFor(() => expect(shown()).toBe(true));
		fireEvent.pointerDown(button, { pointerType: "touch" });
		fireEvent.click(button);
		await waitFor(() => expect(shown()).toBe(false));
	});
});
