// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { baseColors } from "@/colors";
import { AgenticMark } from "./AgenticMark";
import { ChatMessage } from "./ChatMessage";
import { ChatModeBanner } from "./ChatModeBanner";
import { MODE_COLORS } from "./ChatModeSelector";

const ORANGE = /ff8a4c|255,\s*138,\s*76/i;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockImplementation((media: string) => ({
			addEventListener: vi.fn(),
			addListener: vi.fn(),
			matches: false,
			media,
			removeEventListener: vi.fn(),
			removeListener: vi.fn(),
		})),
	);
});

afterEach(cleanup);

const renderUi = (ui: ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">{ui}</MantineProvider>
		</I18nProvider>,
	);

describe("Agentic Chat colour", () => {
	it("is the brand Spring Green, with no orange left in its palette", () => {
		expect(MODE_COLORS.agentic.primary).toBe(baseColors.springGreen);
		expect(JSON.stringify(MODE_COLORS.agentic)).not.toMatch(ORANGE);
	});

	it("marks the mode with a green disc holding a dark sparkle", () => {
		renderUi(<AgenticMark size={20} />);
		const mark = screen.getByTestId("agentic-mark");
		expect(mark.style.backgroundColor).toBe("rgb(30, 255, 161)");
		expect(mark.querySelector("svg")).not.toBeNull();
	});
});

describe("the agentic chat is neutral apart from the mark", () => {
	it("your own message has the same neutral border as the assistant's", () => {
		renderUi(
			// biome-ignore lint/a11y/useValidAriaRole: ChatMessage's own role prop, not ARIA
			<ChatMessage role="user" chatMode="agentic">
				hello
			</ChatMessage>,
		);
		const bubble = screen.getByText("hello").closest(".mantine-Paper-root");
		expect((bubble as HTMLElement).style.borderColor).toBe("");
	});

	it("the banner is a plain surface with the green mark", () => {
		renderUi(<ChatModeBanner mode="agentic" conversationCount={0} />);
		const banner = screen.getByTestId("chat-mode-banner");
		expect(banner.getAttribute("style") ?? "").not.toMatch(ORANGE);
		expect(banner.style.border).not.toMatch(/30,\s*255,\s*161|1effa1/i);
		expect(screen.getByTestId("agentic-mark")).toBeTruthy();
	});

	it("keeps the cyan border on a Specific Details message", () => {
		renderUi(
			// biome-ignore lint/a11y/useValidAriaRole: ChatMessage's own role prop, not ARIA
			<ChatMessage role="user" chatMode="deep_dive">
				hi
			</ChatMessage>,
		);
		const bubble = screen.getByText("hi").closest(".mantine-Paper-root");
		expect((bubble as HTMLElement).style.borderColor).not.toBe("");
	});
});
