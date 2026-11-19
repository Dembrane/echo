// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type EmailChip,
	EmailChipsInput,
	type MemberSuggestion,
} from "./EmailChipsInput";

i18n.loadAndActivate({ locale: "en-US", messages: {} });

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	};
	Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

// The parent owns the chips, as ProjectSharingModal does.
function Harness({ suggestions }: { suggestions?: MemberSuggestion[] }) {
	const [chips, setChips] = useState<EmailChip[]>([]);
	return (
		<>
			<EmailChipsInput
				chips={chips}
				onChipsChange={setChips}
				selfEmail="me@example.com"
				suggestions={suggestions}
				data-testid="chips"
			/>
			<output data-testid="values">
				{chips.map((c) => `${c.value}:${c.state}`).join(" ")}
			</output>
		</>
	);
}

const show = (suggestions?: MemberSuggestion[]) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<Harness suggestions={suggestions} />
			</MantineProvider>
		</I18nProvider>,
	);

const input = () => screen.getByTestId("chips-input") as HTMLInputElement;
const values = () => screen.getByTestId("values").textContent;
const type = (value: string) =>
	fireEvent.change(input(), { target: { value } });
const key = (k: string) => fireEvent.keyDown(input(), { key: k });

describe("EmailChipsInput", () => {
	it("turns what is typed into chips, each one checked", () => {
		show();
		type("a@example.com,");
		expect(values()).toBe("a@example.com:valid");
		expect(input().value).toBe("");
		type("nope");
		key("Enter");
		type("me@example.com");
		key("Enter");
		expect(values()).toBe(
			"a@example.com:valid nope:invalid me@example.com:self",
		);
		expect(screen.getByText("2 addresses need attention")).toBeTruthy();
	});

	it("adds an address once, whatever its case", () => {
		show();
		type("a@example.com");
		key("Enter");
		type("A@Example.com");
		key("Enter");
		expect(values()).toBe("a@example.com:valid");
	});

	it("deletes the last chip on the second Backspace, not the first", () => {
		show();
		type("a@example.com b@example.com ");
		expect(values()).toBe("a@example.com:valid b@example.com:valid");
		key("Backspace");
		expect(values()).toBe("a@example.com:valid b@example.com:valid");
		key("Backspace");
		expect(values()).toBe("a@example.com:valid");
		// Typing in between disarms it again.
		key("Backspace");
		type("x");
		type("");
		key("Backspace");
		expect(values()).toBe("a@example.com:valid");
	});

	it("removes a chip from its own button", () => {
		show();
		type("a@example.com b@example.com ");
		fireEvent.click(
			screen.getByRole("button", { name: "Remove a@example.com" }),
		);
		expect(values()).toBe("b@example.com:valid");
	});

	it("offers known people, minus yourself and anyone already added", async () => {
		show([
			{ displayName: "Ada", email: "ada@example.com" },
			{ displayName: "Bob", email: "bob@example.com" },
			{ displayName: "Me", email: "me@example.com" },
		]);
		fireEvent.focus(input());
		type("a");
		const ada = await screen.findByRole("option", { name: /Ada/ });
		expect(screen.queryByRole("option", { name: /Me/ })).toBeNull();
		fireEvent.click(ada);
		expect(values()).toBe("ada@example.com:valid");
		type("");
		expect(screen.queryByRole("option", { name: /Ada/ })).toBeNull();
		expect(screen.getByRole("option", { name: /Bob/ })).toBeTruthy();
	});
});
