// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
	ChatComposerShell,
	ConversationFocusChips,
	ConversationPickerButton,
} from "./ChatComposer";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");

	// MantineProvider reads the OS color scheme on mount; jsdom has no
	// matchMedia, so stub a minimal (always non-matching) implementation.
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

afterEach(() => {
	cleanup();
});

const renderWithProviders = (ui: React.ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter>{ui}</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

it("renders the textarea slot with the footer controls around it", () => {
	renderWithProviders(
		<ChatComposerShell
			chips={<span>chips</span>}
			footerLeft={<span>left</span>}
			footerRight={<span>right</span>}
		>
			<textarea aria-label="message" />
		</ChatComposerShell>,
	);
	expect(screen.getByLabelText("message")).toBeTruthy();
	expect(screen.getByText("chips")).toBeTruthy();
	expect(screen.getByText("left")).toBeTruthy();
	expect(screen.getByText("right")).toBeTruthy();
});

it("omits the chips row when no chips are passed", () => {
	renderWithProviders(
		<ChatComposerShell>
			<textarea aria-label="message" />
		</ChatComposerShell>,
	);
	expect(screen.queryByTestId("chat-composer-chips")).toBeNull();
});

it("clears every conversation from one control", () => {
	const onClearAll = vi.fn();
	renderWithProviders(
		<ConversationFocusChips
			conversations={[
				{ id: "a", participant_name: "Ada" },
				{ id: "b", participant_name: "Bo" },
			]}
			label="Focusing on 2 conversations:"
			onClearAll={onClearAll}
		/>,
	);
	fireEvent.click(screen.getByTestId("chat-composer-clear-focus"));
	expect(onClearAll).toHaveBeenCalledTimes(1);
});

it("renders no clear control when clearing is not available", () => {
	renderWithProviders(
		<ConversationFocusChips
			conversations={[{ id: "a", participant_name: "Ada" }]}
			label="Using 1 conversation:"
		/>,
	);
	expect(screen.queryByTestId("chat-composer-clear-focus")).toBeNull();
});

it("shows the overflow notice instead of chips when one is given", () => {
	renderWithProviders(
		<ConversationFocusChips
			conversations={[{ id: "a", participant_name: "Ada" }]}
			label="Focusing on 1 conversation:"
			onClearAll={() => {}}
			overflowNotice={<span>too many to list</span>}
		/>,
	);
	expect(screen.getByText("too many to list")).toBeTruthy();
	expect(screen.queryByText("Ada")).toBeNull();
});

it("renders nothing when count is zero and no conversations are given", () => {
	renderWithProviders(
		<ConversationFocusChips count={0} label="Using 0 conversations:" />,
	);
	expect(screen.queryByText("Using 0 conversations:")).toBeNull();
});

it("renders the label without ConversationLinks in count-only mode", () => {
	renderWithProviders(
		<ConversationFocusChips count={3} label="Using 3 conversations:" />,
	);
	expect(screen.getByText("Using 3 conversations:")).toBeTruthy();
	// No conversation objects given, so ConversationLinks has nothing to render.
	expect(screen.queryByRole("link")).toBeNull();
});

it("disables the clear button independently of the clearing spinner", () => {
	const onClearAll = vi.fn();
	renderWithProviders(
		<ConversationFocusChips
			count={2}
			disabled
			label="Using 2 conversations:"
			onClearAll={onClearAll}
		/>,
	);
	const button = screen.getByTestId("chat-composer-clear-focus");
	expect(button.hasAttribute("data-disabled")).toBe(true);
	fireEvent.click(button);
	expect(onClearAll).not.toHaveBeenCalled();
});

it("prefers conversations over count when both are given", () => {
	renderWithProviders(
		<ConversationFocusChips
			conversations={[{ id: "a", participant_name: "Ada" }]}
			count={99}
			label="Using 1 conversation:"
		/>,
	);
	// Real conversation list renders, not the unrelated `count` value.
	expect(screen.getByText("Ada")).toBeTruthy();
});

it("prefers the overflow notice over ConversationLinks even in count-only mode", () => {
	renderWithProviders(
		<ConversationFocusChips
			count={50}
			label="Using 50 conversations:"
			overflowNotice={<span>too many to list</span>}
		/>,
	);
	expect(screen.getByText("too many to list")).toBeTruthy();
});

it("labels the picker button from its prop", () => {
	const onClick = vi.fn();
	renderWithProviders(
		<ConversationPickerButton
			ariaLabel="Focus on conversations"
			label="Focus on conversations"
			onClick={onClick}
			testId="agentic-select-conversations-button"
		/>,
	);
	const button = screen.getByTestId("agentic-select-conversations-button");
	expect(button.textContent).toContain("Focus on conversations");
	expect(button.getAttribute("aria-label")).toBe("Focus on conversations");
	fireEvent.click(button);
	expect(onClick).toHaveBeenCalledTimes(1);
});
