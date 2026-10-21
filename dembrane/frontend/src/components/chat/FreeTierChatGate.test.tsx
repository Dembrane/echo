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

const renderCard = (frozen?: boolean) => {
	const onUpgrade = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ChatTurnLimitCard onUpgrade={onUpgrade} frozen={frozen} />
			</MantineProvider>
		</I18nProvider>,
	);
	return onUpgrade;
};

const FROZEN =
	"This chat is from an earlier free period and can't take new questions. Start a new chat or upgrade to keep going.";
const TURNS =
	"You've reached the free plan limit for this chat. Upgrade to keep the conversation going.";

it("says a frozen chat is read-only and offers the upgrade", () => {
	const onUpgrade = renderCard(true);
	expect(document.body.textContent).toContain(FROZEN);
	expect(document.body.textContent).not.toContain(TURNS);
	fireEvent.click(screen.getByRole("button", { name: "See upgrade options" }));
	expect(onUpgrade).toHaveBeenCalledTimes(1);
});

it("keeps the turn limit text when the chat is not frozen", () => {
	const onUpgrade = renderCard();
	expect(document.body.textContent).toContain(TURNS);
	expect(document.body.textContent).not.toContain(FROZEN);
	fireEvent.click(screen.getByRole("button", { name: "See upgrade options" }));
	expect(onUpgrade).toHaveBeenCalledTimes(1);
});
