// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ChatTurnLimitCard } from "./FreeTierChatGate";

vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: () => null,
}));

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

const renderCard = (questions?: number | null) => {
	const onUpgrade = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ChatTurnLimitCard onUpgrade={onUpgrade} questions={questions} />
			</MantineProvider>
		</I18nProvider>,
	);
	return onUpgrade;
};

const TURNS =
	"You've used this sample project's 10 questions. Create your own project or upgrade to keep going.";

it("names the refusal's cap, shared by the whole sample project", () => {
	renderCard(7);
	expect(document.body.textContent).toContain(
		"You've used this sample project's 7 questions.",
	);
	expect(document.body.textContent).not.toContain("this chat");
});

it("says the sample project's questions are used and offers the upgrade", () => {
	const onUpgrade = renderCard();
	expect(document.body.textContent).toContain(TURNS);
	expect(document.body.textContent).not.toContain("earlier free period");
	expect(document.body.textContent).not.toContain("this month's free chats");
	fireEvent.click(screen.getByRole("button", { name: "See upgrade options" }));
	expect(onUpgrade).toHaveBeenCalledTimes(1);
});

it("keeps only the voice wall and the sample card", async () => {
	const gate = await import("./FreeTierChatGate");
	expect(Object.keys(gate).sort()).toEqual([
		"ChatTurnLimitCard",
		"VoiceCapUpgradeModal",
	]);
});
