// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	SignPromptBanner,
	type SignPromptBannerProps,
} from "./SignPromptBanner";

// The block on its own: what it says, and the two things it hands back. Whether it shows
// at all (closed this session, nothing waiting) is the connected wrapper's, tested in
// ../TasksPrompt.test.tsx.
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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

const show = (over: Partial<SignPromptBannerProps> = {}) => {
	const props: SignPromptBannerProps = {
		nextTask: "Sign the offer",
		onDismiss: vi.fn(),
		onOpen: vi.fn(),
		orgName: "Gemeente Testdorp",
		tasksWaiting: 2,
		...over,
	};
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<SignPromptBanner {...props} />
			</MantineProvider>
		</I18nProvider>,
	);
	return props;
};

describe("SignPromptBanner", () => {
	it("says how many, where and what is next, inline and not as a dialog", () => {
		show();
		const banner = screen.getByTestId("sign-prompt-banner");
		expect(banner.textContent).toContain(
			"You have 2 things to do in Gemeente Testdorp.",
		);
		expect(banner.textContent).toContain("Next: Sign the offer");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("is a labelled region, never an alert that interrupts a screen reader on each page", () => {
		show();
		const banner = screen.getByTestId("sign-prompt-banner");
		expect(banner.getAttribute("role")).toBe("region");
		expect(banner.getAttribute("role")).not.toBe("alert");
		expect(screen.getByRole("region", { name: "Tasks" })).toBe(banner);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("counts one in the singular and leaves out a next task it does not have", () => {
		show({ nextTask: null, tasksWaiting: 1 });
		const text = screen.getByTestId("sign-prompt-banner").textContent ?? "";
		expect(text).toContain("You have 1 thing to do in Gemeente Testdorp");
		expect(text).not.toContain("Next:");
	});

	it("hands back the way to the tasks and the close", () => {
		const props = show();
		fireEvent.click(screen.getByRole("button", { name: "Go to your tasks" }));
		expect(props.onOpen).toHaveBeenCalledTimes(1);
		expect(props.onDismiss).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(props.onDismiss).toHaveBeenCalledTimes(1);
	});

	it("is reachable with the keyboard: both actions are real buttons that take focus", () => {
		show();
		for (const name of ["Go to your tasks", "Close"]) {
			const button = screen.getByRole("button", { name });
			expect(button.tagName).toBe("BUTTON");
			expect(button.getAttribute("tabindex")).not.toBe("-1");
			button.focus();
			expect(document.activeElement).toBe(button);
		}
	});
});
