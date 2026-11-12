// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { WrapUpModal } from "./WrapUpModal";

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
	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		};
	}
});

afterEach(cleanup);

const wrap = (reason: "conversation" | "account", onFinish = vi.fn()) => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<WrapUpModal opened reason={reason} onFinish={onFinish} />
			</MantineProvider>
		</I18nProvider>,
	);
	return onFinish;
};

const dialogText = () => document.body.textContent ?? "";

it.each([
	[
		"conversation",
		"This conversation has reached its maximum length. Everything you recorded is saved.",
	],
	[
		"account",
		"Recording has stopped for now. Everything you recorded is saved.",
	],
] as const)("shows the %s copy and a Finish button", (reason, copy) => {
	wrap(reason);
	expect(screen.getByText("That's a wrap")).toBeTruthy();
	expect(screen.getByText(copy)).toBeTruthy();
	expect(screen.getByRole("button", { name: "Finish" })).toBeTruthy();
});

it("Finish calls onFinish", () => {
	const onFinish = wrap("account");
	fireEvent.click(screen.getByRole("button", { name: "Finish" }));
	expect(onFinish).toHaveBeenCalledTimes(1);
});

it.each(["conversation", "account"] as const)(
	"%s copy never mentions plans or limits",
	(reason) => {
		wrap(reason);
		const text = dialogText().toLowerCase();
		for (const word of ["plan", "upgrade", "hour", "limit"]) {
			expect(text).not.toContain(word);
		}
		expect(text).not.toContain("—");
	},
);

it("has no close button", () => {
	wrap("conversation");
	expect(screen.getAllByRole("button")).toHaveLength(1);
});
