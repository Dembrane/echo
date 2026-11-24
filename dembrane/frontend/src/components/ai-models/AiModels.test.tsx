// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ProjectAiModels } from "../project/advanced/ProjectAiModels";
import type { OrgAiProviders, ProjectAiProviders } from "./hooks";
import { OrgAiModelsPanel } from "./OrgAiModelsPanel";

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

const wrap = (ui: React.ReactNode) =>
	render(
		<MemoryRouter>
			<QueryClientProvider client={new QueryClient()}>
				<I18nProvider i18n={i18n}>
					<MantineProvider>{ui}</MantineProvider>
				</I18nProvider>
			</QueryClientProvider>
		</MemoryRouter>,
	);

it("an account with only Scaleway shows its default and the way to ask for Google", () => {
	org = {
		allowed: ["scaleway"],
		available: ["scaleway", "google"],
		default: "scaleway",
		environment_default: "scaleway",
		history: [],
	};
	wrap(<OrgAiModelsPanel orgId="o" orgName="Acme" />);
	expect(screen.getByText("Default: Scaleway, Paris")).toBeTruthy();
	expect(screen.getByText("Ask for Google Vertex AI")).toBeTruthy();
	expect(screen.queryByText(/Also available/)).toBeNull();
});

it("the request dialog's Send is the filled button and comes before Cancel, as in the project's confirm", async () => {
	org = {
		allowed: ["scaleway"],
		available: ["scaleway", "google"],
		default: "scaleway",
		environment_default: "scaleway",
		history: [],
	};
	wrap(<OrgAiModelsPanel orgId="o" orgName="Acme" />);
	fireEvent.click(screen.getByTestId("ask-google-vertex"));
	const send = await screen.findByTestId("question-send");
	const cancel = screen.getByText("Cancel").closest("button") as HTMLElement;
	expect(send.getAttribute("data-variant")).toBe("filled");
	expect(
		send.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});

it("an account with Google shows both and each change with who asked when", () => {
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
	};
	wrap(<OrgAiModelsPanel orgId="o" orgName="Acme" />);
	expect(screen.getByText("Default: Scaleway, Paris")).toBeTruthy();
	expect(
		screen.getByText("Also available: Google Vertex AI, EU, billed per use"),
	).toBeTruthy();
	expect(screen.queryByText("Ask for Google Vertex AI")).toBeNull();
	expect(
		screen.getByText(
			"Google Vertex AI added by Dembrane, 3 Dec 2026, at your request of 2 Dec 2026",
		),
	).toBeTruthy();
});

it("the project field is not there for an account with one provider or for a member", () => {
	project = {
		account_default: "scaleway",
		can_change: true,
		current: null,
		effective: "scaleway",
		options: ["scaleway"],
	};
	const { rerender } = wrap(<ProjectAiModels projectId="p" />);
	expect(screen.queryByTestId("project-ai-models-section")).toBeNull();
	project = { ...project, can_change: false, options: ["scaleway", "google"] };
	rerender(
		<MemoryRouter>
			<QueryClientProvider client={new QueryClient()}>
				<I18nProvider i18n={i18n}>
					<MantineProvider>
						<ProjectAiModels projectId="p" />
					</MantineProvider>
				</I18nProvider>
			</QueryClientProvider>
		</MemoryRouter>,
	);
	expect(screen.queryByTestId("project-ai-models-section")).toBeNull();
});

it("choosing Google asks once; going back to Scaleway asks nothing", async () => {
	project = {
		account_default: "scaleway",
		can_change: true,
		current: null,
		effective: "scaleway",
		options: ["scaleway", "google"],
	};
	wrap(<ProjectAiModels projectId="p" />);
	fireEvent.click(screen.getByTestId("project-ai-models-select"));
	fireEvent.click(screen.getByText("Google Vertex AI, EU"));
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

it("going back to the default provider saves at once", () => {
	project = {
		account_default: "scaleway",
		can_change: true,
		current: "google",
		effective: "google",
		options: ["scaleway", "google"],
	};
	wrap(<ProjectAiModels projectId="p" />);
	fireEvent.click(screen.getByTestId("project-ai-models-select"));
	fireEvent.click(screen.getByText("Scaleway, Paris (account default)"));
	expect(mutate).toHaveBeenCalledWith(null);
	expect(
		screen.queryByText("Use Google Vertex AI for this project?"),
	).toBeNull();
});
