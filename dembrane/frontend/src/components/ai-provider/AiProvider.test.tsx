// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
	isChanged,
	makeDefault,
	setEnabled,
} from "@/features/accounts/staff/aiProviderRules";
import { ProjectAiProvider } from "../project/advanced/ProjectAiProvider";
import type { OrgAiProviders, ProjectAiProviders } from "./hooks";
import { OrgAiProviderPanel } from "./OrgAiProviderPanel";
import { modelNames, ProviderCard } from "./ProviderCard";

vi.mock("posthog-js", () => ({ default: { capture: () => {} } }));

let org: OrgAiProviders;
let project: ProjectAiProviders;
const mutate = vi.fn();

vi.mock("./hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./hooks")>();
	return {
		...actual,
		useOrgAiProvidersQuery: () => ({ data: org, isLoading: false }),
		useProjectAiProviderQuery: () => ({ data: project }),
		useSetProjectAiProviderMutation: () => ({ isPending: false, mutate }),
	};
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	Element.prototype.scrollIntoView = () => {};
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
		} as unknown as typeof ResizeObserver;
	}
});

afterEach(() => {
	cleanup();
	mutate.mockReset();
});

const tree = (ui: React.ReactNode) => (
	<MemoryRouter>
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>{ui}</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>
	</MemoryRouter>
);
const wrap = (ui: React.ReactNode) => render(tree(ui));

const MODELS = { scaleway: ["whisper-large-v3", "glm-5.3"] };

it("a Scaleway card names its models from the config and a Google card lists its own lines", () => {
	wrap(
		<>
			<ProviderCard provider="scaleway" models={MODELS.scaleway} />
			<ProviderCard provider="google" />
		</>,
	);
	for (const line of [
		"Paris",
		"Open models: Whisper and GLM 5.3",
		"Good for English and Dutch",
		"EU",
		"Slightly better quality",
		"Closed models: Gemini",
		"Billed per use",
	])
		expect(screen.getByText(line)).toBeTruthy();
	expect(screen.getAllByText("Runs in the EU")).toHaveLength(2);
	expect(screen.getByText("Scaleway")).toBeTruthy();
	expect(screen.getByText("Google Vertex AI")).toBeTruthy();
	expect(screen.getByTestId("provider-logo-scaleway")).toBeTruthy();
	expect(screen.getByTestId("provider-logo-google")).toBeTruthy();
});

it("a model the map does not know shows as its id, and one name is shown once", () => {
	expect(
		modelNames(["whisper-large-v3", "whisper-large-v3-turbo", "glm-5.3"]),
	).toEqual(["Whisper", "GLM 5.3"]);
	expect(modelNames(["some-new-model"])).toEqual(["some-new-model"]);
	wrap(
		<ProviderCard
			provider="scaleway"
			models={["whisper-large-v3", "some-new-model"]}
		/>,
	);
	expect(
		screen.getByText("Open models: Whisper and some-new-model"),
	).toBeTruthy();
});

it("an account with only Scaleway shows its default and Google muted as not enabled, with no way to ask", () => {
	org = {
		allowed: ["scaleway"],
		available: ["scaleway", "google"],
		default: "scaleway",
		environment_default: "scaleway",
		history: [],
		models: MODELS,
	};
	wrap(<OrgAiProviderPanel orgId="o" />);
	expect(screen.getByText("Default")).toBeTruthy();
	expect(screen.getByText("Not enabled")).toBeTruthy();
	expect(
		screen.getByTestId("org-provider-google").querySelector("[data-muted]"),
	).toBeTruthy();
	expect(
		screen.getByTestId("org-provider-scaleway").querySelector("[data-muted]"),
	).toBeNull();
	expect(screen.queryByText(/Ask for Google/)).toBeNull();
	expect(screen.queryByText("Request")).toBeNull();
});

it("a muted card offers its request button only when it is given one", () => {
	const onRequest = vi.fn();
	wrap(<ProviderCard provider="google" muted onRequest={onRequest} />);
	fireEvent.click(screen.getByText("Request"));
	expect(onRequest).toHaveBeenCalledOnce();
});

it("an account with Google shows Default and Enabled, and each change with who asked when", () => {
	org = {
		allowed: ["scaleway", "google"],
		available: ["scaleway", "google"],
		default: "scaleway",
		environment_default: "scaleway",
		history: [
			{
				at: "2026-12-03T10:00:00Z",
				kind: "added",
				provider: "google",
				request_at: "2026-12-02T09:00:00Z",
			},
		],
		models: MODELS,
	};
	wrap(<OrgAiProviderPanel orgId="o" />);
	expect(screen.getByText("Default")).toBeTruthy();
	expect(screen.getByText("Enabled")).toBeTruthy();
	expect(screen.queryByText("Not enabled")).toBeNull();
	expect(
		screen.getByText(
			"Google Vertex AI added by Dembrane, 3 Dec 2026, at your request of 2 Dec 2026",
		),
	).toBeTruthy();
});

it("the project choice is not there for an account with one provider or for a member", () => {
	project = {
		account_default: "scaleway",
		can_change: true,
		current: null,
		effective: "scaleway",
		options: ["scaleway"],
	};
	const { rerender } = wrap(<ProjectAiProvider projectId="p" />);
	expect(screen.queryByRole("radiogroup")).toBeNull();
	project = { ...project, can_change: false, options: ["scaleway", "google"] };
	rerender(tree(<ProjectAiProvider projectId="p" />));
	expect(screen.queryByRole("radiogroup")).toBeNull();
});

it("the project shows cards, marks the account default, and choosing Google asks once", async () => {
	project = {
		account_default: "scaleway",
		can_change: true,
		current: null,
		effective: "scaleway",
		models: MODELS,
		options: ["scaleway", "google"],
	};
	wrap(<ProjectAiProvider projectId="p" />);
	expect(screen.getAllByRole("radio")).toHaveLength(2);
	expect(screen.getByText("Account default")).toBeTruthy();
	expect(screen.getByText("Open models: Whisper and GLM 5.3")).toBeTruthy();
	fireEvent.click(screen.getByTestId("project-provider-google"));
	expect(
		await screen.findByText("Use Google Vertex AI for this project?"),
	).toBeTruthy();
	expect(
		screen.getByText(
			"New conversations and all analysis in this project go to Google in the EU, billed per use.",
		),
	).toBeTruthy();
	expect(mutate).not.toHaveBeenCalled();
	fireEvent.click(screen.getByText("Use Google"));
	expect(mutate).toHaveBeenCalledWith("google", expect.anything());
});

it("going back to the account default saves at once and asks nothing", () => {
	project = {
		account_default: "scaleway",
		can_change: true,
		current: "google",
		effective: "google",
		options: ["scaleway", "google"],
	};
	wrap(<ProjectAiProvider projectId="p" />);
	fireEvent.click(screen.getByTestId("project-provider-scaleway"));
	expect(mutate).toHaveBeenCalledWith(null);
	expect(
		screen.queryByText("Use Google Vertex AI for this project?"),
	).toBeNull();
});

const ORDER = ["scaleway", "google"] as const;

it("staff: the default cannot be switched off and one provider always stays", () => {
	const both = {
		allowed: ["scaleway", "google"] as const,
		default: "scaleway" as const,
	};
	const draft = { allowed: [...both.allowed], default: both.default };
	expect(setEnabled(draft, "scaleway", false, ORDER)).toBe(draft);
	const afterOff = setEnabled(draft, "google", false, ORDER);
	expect(afterOff.allowed).toEqual(["scaleway"]);
	expect(setEnabled(afterOff, "scaleway", false, ORDER)).toBe(afterOff);
	const googleDefault = {
		allowed: ["scaleway", "google"] as ("scaleway" | "google")[],
		default: "google" as const,
	};
	expect(setEnabled(googleDefault, "google", false, ORDER)).toBe(googleDefault);
	expect(setEnabled(googleDefault, "scaleway", false, ORDER).allowed).toEqual([
		"google",
	]);
});

it("staff: only an enabled provider can be made the default, and switching on keeps the card order", () => {
	const draft = {
		allowed: ["scaleway" as const],
		default: "scaleway" as const,
	};
	expect(makeDefault(draft, "google")).toBe(draft);
	const on = setEnabled(draft, "google", true, ORDER);
	expect(on.allowed).toEqual(["scaleway", "google"]);
	expect(makeDefault(on, "google").default).toBe("google");
	expect(isChanged(on, draft)).toBe(true);
	expect(isChanged(draft, { ...draft })).toBe(false);
});
