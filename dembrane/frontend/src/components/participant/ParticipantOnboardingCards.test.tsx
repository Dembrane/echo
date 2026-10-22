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
const systemCards = vi.hoisted(() => ({
	current: [
		{ section: "Intro", slides: [{ content: "Hi", title: "Welcome" }] },
	] as unknown[],
}));
vi.mock("./hooks/useOnboardingCards", () => ({
	useOnboardingCards: () => ({
		getSystemCards: () => systemCards.current,
	}),
}));
vi.mock("./ParticipantInitiateForm", () => ({
	ParticipantInitiateForm: ({
		onRefusedChange,
		consentGiven,
	}: {
		onRefusedChange?: (refused: boolean) => void;
		consentGiven?: boolean;
	}) => (
		<>
			<button type="button" onClick={() => onRefusedChange?.(true)}>
				refuse
			</button>
			<span>{consentGiven ? "consented" : "no consent"}</span>
		</>
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

afterEach(cleanup);

const project = {
	id: "p1",
	tags: [],
} as unknown as ParticipantProject;

const wrap = (url: string) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[url]}>
					<ParticipantOnboardingCards project={project} />
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

it("tells the form consent was given once the checkbox is ticked", () => {
	const intro = systemCards.current;
	systemCards.current = [
		{
			section: "Privacy",
			slides: [
				{
					checkbox: { label: "I agree", required: true },
					title: "Privacy",
				},
			],
		},
	];
	try {
		wrap("/en-US/p1/start");
		fireEvent.click(screen.getByTestId("portal-onboarding-checkbox"));
		fireEvent.click(screen.getByTestId("portal-onboarding-next-button"));
		expect(screen.getByText("consented")).toBeTruthy();
	} finally {
		systemCards.current = intro;
	}
});

it("never claims consent when onboarding is skipped", () => {
	wrap("/en-US/p1/start?skipOnboarding=1");
	expect(screen.getByText("no consent")).toBeTruthy();
});
