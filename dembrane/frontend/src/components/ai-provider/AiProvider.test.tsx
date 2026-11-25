// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
	isChanged,
	isLocked,
	makeDefault,
	type ProviderDraft,
	type Serves,
	setEnabled,
} from "@/features/accounts/staff/aiProviderRules";
import { ProjectAiProvider } from "../project/advanced/ProjectAiProvider";
import type {
	AiProvider,
	CostLine,
	OrgAiProviders,
	ProjectAiProviders,
} from "./hooks";
import { euros } from "./hooks";
import { OrgAiProviderPanel, requestTicket } from "./OrgAiProviderPanel";
import { modelNames, ProviderCard } from "./ProviderCard";

vi.mock("posthog-js", () => ({ default: { capture: () => {} } }));

let org: OrgAiProviders;
let project: ProjectAiProviders;
const mutate = vi.fn();
const openTicket = vi.fn();

vi.mock("@/features/accounts/api/hooks", () => ({
	useAccountsMutation: () => ({ mutate: openTicket }),
}));

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
	openTicket.mockReset();
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

const MODELS = {
	scaleway: {
		analysis: ["glm-5.3"],
		transcription: ["whisper-large-v3"],
	},
};

it("a Scaleway card names the models of its job from the config and a Google card lists its own lines", () => {
	wrap(
		<>
			<ProviderCard
				provider="scaleway"
				models={MODELS.scaleway.transcription}
			/>
			<ProviderCard provider="scaleway" models={MODELS.scaleway.analysis} />
			<ProviderCard provider="google" />
		</>,
	);
	for (const line of [
		"Open models: Whisper",
		"Open models: GLM 5.3",
		"EU",
		"Slightly better quality",
		"Closed models: Gemini",
	])
		expect(screen.getByText(line)).toBeTruthy();
	expect(screen.getAllByText("Paris")).toHaveLength(2);
	expect(screen.getAllByText("Good for English and Dutch")).toHaveLength(2);
	expect(screen.getAllByText("Runs in the EU")).toHaveLength(3);
	expect(screen.getAllByText("Scaleway")).toHaveLength(2);
	expect(screen.getByText("Google Vertex AI")).toBeTruthy();
	expect(screen.getAllByTestId("provider-logo-scaleway")).toHaveLength(2);
	expect(screen.getByTestId("provider-logo-google")).toBeTruthy();
});

it("amounts are written in the reader's locale with the euro sign", () => {
	expect(euros(12, "en-US", "estimate")).toBe("€12");
	expect(euros(12.4, "en-GB")).toBe("€12.40");
	expect(euros(12, "nl-NL", "estimate")).toBe("€\u00a012");
	// Below one euro an estimate keeps its cents.
	expect(euros(0.5, "en-US", "estimate")).toBe("€0.50");
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

const BOTH_JOBS = ["transcription", "analysis"] as const;
const SERVES = {
	google: [...BOTH_JOBS],
	scaleway: [...BOTH_JOBS],
};

const line = (
	provider: AiProvider,
	job: "transcription" | "analysis",
	over: Partial<CostLine> = {},
): CostLine => ({
	billing: provider === "scaleway" ? "included" : "on_top",
	job,
	monthly_eur: null,
	per_100_calls_eur: null,
	per_hour_eur: null,
	provider,
	...over,
});

const orgBase = (over: Partial<OrgAiProviders> = {}): OrgAiProviders => ({
	available: ["scaleway", "google"],
	cost: {
		analysis: {
			google: line("google", "analysis", { per_100_calls_eur: 2.5 }),
			scaleway: line("scaleway", "analysis"),
		},
		transcription: {
			google: line("google", "transcription", { per_hour_eur: 1.8 }),
			scaleway: line("scaleway", "transcription"),
		},
	},
	defaults: { analysis: "scaleway", transcription: "scaleway" },
	enabled: { analysis: ["scaleway"], transcription: ["scaleway"] },
	environment_default: "scaleway",
	history: [],
	jobs: [...BOTH_JOBS],
	models: MODELS,
	month: {
		from: "2026-12-01T00:00:00Z",
		spent: { google: 0, scaleway: 0 },
	},
	serves: SERVES,
	...over,
});

it("an account with only Scaleway shows two jobs, Scaleway as default and Google muted with its price and a Request button", () => {
	org = orgBase();
	wrap(<OrgAiProviderPanel orgId="o" />);
	expect(screen.getByText("Transcription")).toBeTruthy();
	expect(screen.getByText("Analysis")).toBeTruthy();
	expect(screen.getAllByText("Default")).toHaveLength(2);
	expect(screen.getAllByText("Not enabled")).toHaveLength(2);
	for (const job of BOTH_JOBS) {
		expect(
			screen
				.getByTestId(`org-provider-${job}-google`)
				.querySelector("[data-muted]"),
		).toBeTruthy();
		expect(
			screen
				.getByTestId(`org-provider-${job}-scaleway`)
				.querySelector("[data-muted]"),
		).toBeNull();
	}
	// Each job's card names the models of that job only.
	for (const [job, models] of [
		["transcription", "Open models: Whisper"],
		["analysis", "Open models: GLM 5.3"],
	] as const) {
		const card = within(screen.getByTestId(`org-provider-${job}-scaleway`));
		expect(card.getByText(models)).toBeTruthy();
		expect(card.getAllByText(/^Open models:/)).toHaveLength(1);
	}
	// One cost line per card: included, or what an hour or a hundred questions would cost.
	expect(screen.getAllByText("Included in your plan")).toHaveLength(2);
	expect(screen.getByText("€1.80 per hour of audio")).toBeTruthy();
	expect(screen.getByText("€2.50 per 100 questions")).toBeTruthy();
	expect(screen.getAllByText("Request")).toHaveLength(2);
	expect(
		screen.getByText("This month: Scaleway included, Google €0.00"),
	).toBeTruthy();
});

it("the explainer has a place beside each job's title", () => {
	org = orgBase();
	wrap(
		<OrgAiProviderPanel
			orgId="o"
			explainers={{
				analysis: <span data-testid="x-analysis" />,
				transcription: <span data-testid="x-transcription" />,
			}}
		/>,
	);
	expect(screen.getByTestId("x-transcription")).toBeTruthy();
	expect(screen.getByTestId("x-analysis")).toBeTruthy();
});

it("Request opens a ticket in the account's ticket list that names the provider and the job, once", () => {
	org = orgBase();
	wrap(<OrgAiProviderPanel orgId="o" />);
	const card = screen.getByTestId("org-provider-analysis-google");
	fireEvent.click(card.querySelector("button") as HTMLElement);
	expect(openTicket).toHaveBeenCalledOnce();
	expect(openTicket.mock.calls[0]?.[0]).toEqual({
		body: {
			body: "Please enable Google Vertex AI for Analysis on our account.",
			subject: "Google Vertex AI for Analysis",
		},
	});
	expect(requestTicket("google", "transcription").subject).toBe(
		"Google Vertex AI for Transcription",
	);
	// The other job's card is untouched.
	expect(
		screen
			.getByTestId("org-provider-transcription-google")
			.querySelector("button")?.disabled,
	).toBe(false);
});

it("a request that went through rests the button as Requested", () => {
	org = orgBase();
	openTicket.mockImplementation((_input, o) => o.onSuccess());
	wrap(<OrgAiProviderPanel orgId="o" />);
	const card = screen.getByTestId("org-provider-analysis-google");
	fireEvent.click(card.querySelector("button") as HTMLElement);
	expect(screen.getByText("Requested")).toBeTruthy();
	expect(
		(screen.getByText("Requested").closest("button") as HTMLButtonElement)
			.disabled,
	).toBe(true);
});

it("Google enabled for analysis only: Default and Enabled badges, the price at last 30 days, the log and the month", () => {
	org = orgBase({
		cost: {
			analysis: {
				google: line("google", "analysis", { monthly_eur: 9.4 }),
				scaleway: line("scaleway", "analysis"),
			},
			transcription: {
				google: line("google", "transcription", { per_hour_eur: 1.8 }),
				scaleway: line("scaleway", "transcription"),
			},
		},
		enabled: {
			analysis: ["scaleway", "google"],
			transcription: ["scaleway"],
		},
		history: [
			{
				at: "2026-12-03T10:00:00Z",
				job: "analysis",
				kind: "enabled",
				provider: "google",
				request_at: "2026-12-02T09:00:00Z",
			},
		],
		month: {
			from: "2026-12-01T00:00:00Z",
			spent: { google: 12.4, scaleway: 3 },
		},
	});
	wrap(<OrgAiProviderPanel orgId="o" />);
	const analysis = screen.getByTestId("org-job-analysis");
	expect(within(analysis).getByText("Default")).toBeTruthy();
	expect(within(analysis).getByText("Enabled")).toBeTruthy();
	expect(within(analysis).queryByText("Not enabled")).toBeNull();
	expect(
		within(analysis).getByText(
			"About €9 a month at your last 30 days of use, billed on top",
		),
	).toBeTruthy();
	expect(
		within(screen.getByTestId("org-job-transcription")).getByText(
			"Not enabled",
		),
	).toBeTruthy();
	expect(
		screen.getByText("3 Dec 2026 · Google Vertex AI enabled for Analysis"),
	).toBeTruthy();
	expect(
		screen.getByText("This month: Scaleway included, Google €12.40"),
	).toBeTruthy();
});

const choice = (over: object = {}) => ({
	account_default: "scaleway" as const,
	current: null,
	effective: "scaleway" as const,
	options: ["scaleway", "google"] as ("scaleway" | "google")[],
	...over,
});

const projectBase = (
	over: Partial<ProjectAiProviders> = {},
): ProjectAiProviders => ({
	can_change: true,
	cost: {
		analysis: {
			google: line("google", "analysis", { monthly_eur: 9 }),
			scaleway: line("scaleway", "analysis"),
		},
		transcription: {
			google: line("google", "transcription", { per_hour_eur: 1.8 }),
			scaleway: line("scaleway", "transcription"),
		},
	},
	jobs: { analysis: choice(), transcription: choice() },
	models: MODELS,
	...over,
});

it("the project choice is not there for an account with one provider or for a member", () => {
	const one = choice({ options: ["scaleway"] });
	project = projectBase({ jobs: { analysis: one, transcription: one } });
	const { rerender } = wrap(<ProjectAiProvider projectId="p" />);
	expect(screen.queryByRole("radiogroup")).toBeNull();
	project = projectBase({ can_change: false });
	rerender(tree(<ProjectAiProvider projectId="p" />));
	expect(screen.queryByRole("radiogroup")).toBeNull();
});

it("only a job with more than one provider shows a choice", () => {
	project = projectBase({
		jobs: {
			analysis: choice(),
			transcription: choice({ options: ["scaleway"] }),
		},
	});
	wrap(<ProjectAiProvider projectId="p" />);
	expect(screen.getByTestId("project-job-analysis")).toBeTruthy();
	expect(screen.queryByTestId("project-job-transcription")).toBeNull();
});

it("the project shows a choice per job with the account default marked and a cost line each", () => {
	project = projectBase();
	wrap(<ProjectAiProvider projectId="p" />);
	expect(screen.getAllByRole("radio")).toHaveLength(4);
	expect(screen.getAllByText("Account default")).toHaveLength(2);
	expect(
		within(screen.getByTestId("project-job-analysis")).getByText(
			"About €9 a month at your last 30 days of use, billed on top",
		),
	).toBeTruthy();
	expect(
		within(screen.getByTestId("project-job-transcription")).getByText(
			"€1.80 per hour of audio",
		),
	).toBeTruthy();
});

it("choosing Google for a job asks once, with the price, and saves only that job", async () => {
	project = projectBase();
	wrap(<ProjectAiProvider projectId="p" />);
	fireEvent.click(screen.getByTestId("project-provider-analysis-google"));
	expect(
		await screen.findByText("Use Google Vertex AI for Analysis?"),
	).toBeTruthy();
	expect(
		screen.getByText(
			"Analysis in this project goes to Google in the EU, billed on top of your plan, about €9 a month at your last 30 days of use.",
		),
	).toBeTruthy();
	expect(mutate).not.toHaveBeenCalled();
	fireEvent.click(screen.getByText("Use Google"));
	expect(mutate).toHaveBeenCalledWith(
		{ job: "analysis", provider: "google" },
		expect.anything(),
	);
});

it("the confirm leaves the estimate out when there is no history", async () => {
	project = projectBase({
		cost: {
			analysis: {},
			transcription: {
				google: line("google", "transcription", { per_hour_eur: 1.8 }),
				scaleway: line("scaleway", "transcription"),
			},
		},
	});
	wrap(<ProjectAiProvider projectId="p" />);
	fireEvent.click(screen.getByTestId("project-provider-transcription-google"));
	expect(
		await screen.findByText("Use Google Vertex AI for Transcription?"),
	).toBeTruthy();
	expect(
		screen.getByText(
			"Transcription in this project goes to Google in the EU, billed on top of your plan.",
		),
	).toBeTruthy();
});

it("cancelling the confirm saves nothing", async () => {
	project = projectBase();
	wrap(<ProjectAiProvider projectId="p" />);
	fireEvent.click(screen.getByTestId("project-provider-analysis-google"));
	fireEvent.click(await screen.findByText("Cancel"));
	expect(mutate).not.toHaveBeenCalled();
});

it("going back to the account default saves at once and asks nothing", () => {
	project = projectBase({
		jobs: {
			analysis: choice({ current: "google", effective: "google" }),
			transcription: choice(),
		},
	});
	wrap(<ProjectAiProvider projectId="p" />);
	fireEvent.click(screen.getByTestId("project-provider-analysis-scaleway"));
	expect(mutate).toHaveBeenCalledWith({ job: "analysis", provider: null });
	expect(screen.queryByText(/^Use Google Vertex AI for/)).toBeNull();
});

const ORDER = ["scaleway", "google"] as const;
const draftOf = (over: Partial<ProviderDraft> = {}): ProviderDraft => ({
	defaults: { analysis: "scaleway", transcription: "scaleway" },
	enabled: {
		analysis: ["scaleway", "google"],
		transcription: ["scaleway", "google"],
	},
	...over,
});
const serves: Serves = SERVES;

it("staff: the default cannot be switched off for its job and one provider always stays", () => {
	const draft = draftOf();
	expect(setEnabled(draft, "analysis", "scaleway", false, ORDER, serves)).toBe(
		draft,
	);
	const afterOff = setEnabled(
		draft,
		"analysis",
		"google",
		false,
		ORDER,
		serves,
	);
	expect(afterOff.enabled.analysis).toEqual(["scaleway"]);
	// The other job is untouched.
	expect(afterOff.enabled.transcription).toEqual(["scaleway", "google"]);
	expect(
		setEnabled(afterOff, "analysis", "scaleway", false, ORDER, serves),
	).toBe(afterOff);
	const googleDefault = draftOf({
		defaults: { analysis: "google", transcription: "scaleway" },
	});
	expect(
		setEnabled(googleDefault, "analysis", "google", false, ORDER, serves),
	).toBe(googleDefault);
	// Google is not the default of transcription, so it can go there.
	expect(
		setEnabled(googleDefault, "transcription", "google", false, ORDER, serves)
			.enabled.transcription,
	).toEqual(["scaleway"]);
});

it("staff: the default's switch reads as on and locked, and only it", () => {
	const draft = draftOf({
		defaults: { analysis: "google", transcription: "scaleway" },
	});
	expect(isLocked(draft, "analysis", "google")).toBe(true);
	expect(isLocked(draft, "analysis", "scaleway")).toBe(false);
	expect(isLocked(draft, "transcription", "scaleway")).toBe(true);
	expect(isLocked(draft, "transcription", "google")).toBe(false);
});

it("staff: only an enabled provider that serves the job can be its default or be switched on for it", () => {
	const draft = draftOf({
		enabled: { analysis: ["scaleway"], transcription: ["scaleway"] },
	});
	expect(makeDefault(draft, "analysis", "google")).toBe(draft);
	const on = setEnabled(draft, "analysis", "google", true, ORDER, serves);
	expect(on.enabled.analysis).toEqual(["scaleway", "google"]);
	expect(on.enabled.transcription).toEqual(["scaleway"]);
	expect(makeDefault(on, "analysis", "google").defaults.analysis).toBe(
		"google",
	);
	expect(isChanged(on, draft)).toBe(true);
	expect(isChanged(draft, { ...draft })).toBe(false);
	// A provider that serves transcription only (the shape Orai will have) never goes on for analysis.
	const speechOnly: Serves = {
		google: ["transcription"],
		scaleway: [...BOTH_JOBS],
	};
	expect(setEnabled(draft, "analysis", "google", true, ORDER, speechOnly)).toBe(
		draft,
	);
	expect(
		setEnabled(draft, "transcription", "google", true, ORDER, speechOnly)
			.enabled.transcription,
	).toEqual(["scaleway", "google"]);
});
