// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ChatModeSelector } from "./ChatModeSelector";

vi.mock("./hooks", () => ({
	useInitializeChatModeMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

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

afterEach(() => cleanup());

const renderSelector = (aiUsedUp?: boolean) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ChatModeSelector isNewChat projectId="p1" aiUsedUp={aiUsedUp} />
			</MantineProvider>
		</I18nProvider>,
	);

it("marks the modes with the used-up AI budget, never a chat count", () => {
	renderSelector(true);
	const text = document.body.textContent ?? "";
	expect(text).toContain("AI budget used up");
	expect(text).not.toContain("Chat limit reached");
});

it("shows no badge while the AI budget has room", () => {
	renderSelector(false);
	expect(document.body.textContent).not.toContain("AI budget used up");
});
