// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import ParticipantOnboardingCards from "./ParticipantOnboardingCards";

vi.mock("posthog-js", () => ({ default: { capture: () => {} } }));
vi.mock("@/components/common/Logo", () => ({ Logo: () => null }));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));
const welcomeOnly = [
	{ section: "Intro", slides: [{ content: "Hi", title: "Welcome" }] },
];
let systemCards: unknown[] = welcomeOnly;
vi.mock("./onboardingCards", () => ({
	getSystemCards: () => systemCards,
}));
vi.mock("./ParticipantInitiateForm", () => ({
	ParticipantInitiateForm: ({
		onRefusedChange,
	}: {
		onRefusedChange?: (refused: boolean) => void;
	}) => (
		<button type="button" onClick={() => onRefusedChange?.(true)}>
			refuse
		</button>
	),
	portalHasNothingToAsk: () => false,
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

afterEach(() => {
	cleanup();
	systemCards = welcomeOnly;
});

const project = {
	id: "p1",
	tags: [],
} as unknown as ParticipantProject;

const wrap = (url: string, initialSlide?: "first" | "privacy" | "last") =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[url]}>
					<ParticipantOnboardingCards
						project={project}
						initialSlide={initialSlide}
					/>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

it("drops the heading and Back once the start is refused", () => {
	wrap("/en-US/p1/start");
	fireEvent.click(screen.getByTestId("portal-onboarding-next-button"));
	expect(screen.getByText("Ready to begin?")).toBeTruthy();
	expect(screen.getByTestId("portal-onboarding-back-button")).toBeTruthy();

	fireEvent.click(screen.getByText("refuse"));

	expect(screen.queryByText("Ready to begin?")).toBeNull();
	expect(screen.queryByTestId("portal-onboarding-back-button")).toBeNull();
});

it("drops the heading once the start is refused when onboarding is skipped", () => {
	wrap("/en-US/p1/start?skipOnboarding=1");
	expect(screen.getByText("Ready to begin?")).toBeTruthy();

	fireEvent.click(screen.getByText("refuse"));

	expect(screen.queryByText("Ready to begin?")).toBeNull();
});

const withPrivacy = [
	{
		section: "Intro",
		slides: [
			{ content: "Hi", title: "Welcome" },
			{
				checkbox: { label: "I agree", required: true },
				content: "We keep it safe",
				title: "Your privacy",
				type: "privacy",
			},
		],
	},
];

it("opens on the first card by default", () => {
	wrap("/en-US/p1/start");
	expect(screen.getByText("Welcome")).toBeTruthy();
});

it("opens on the last card when asked", () => {
	wrap("/en-US/p1/start", "last");
	expect(screen.getByText("Ready to begin?")).toBeTruthy();
});

it("opens on the privacy card when asked", () => {
	systemCards = withPrivacy;
	wrap("/en-US/p1/start", "privacy");
	expect(screen.getByText("Your privacy")).toBeTruthy();
});

it("holds Next on a required checkbox until it is ticked", () => {
	systemCards = withPrivacy;
	wrap("/en-US/p1/start", "privacy");
	const next = screen.getByTestId("portal-onboarding-next-button");
	expect(next).toHaveProperty("disabled", true);

	fireEvent.click(screen.getByLabelText("I agree"));
	expect(next).toHaveProperty("disabled", false);
	fireEvent.click(next);

	expect(screen.getByText("Ready to begin?")).toBeTruthy();
});
