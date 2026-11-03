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

const renderCard = () => {
	const onUpgrade = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ChatTurnLimitCard onUpgrade={onUpgrade} />
			</MantineProvider>
		</I18nProvider>,
	);
	return onUpgrade;
};

const TURNS =
	"You've reached the free plan limit for this chat. Upgrade to keep the conversation going.";

it("says the sample chat's turns are used and offers the upgrade", () => {
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
