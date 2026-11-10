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
	waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEMPLATE_SUMMARIES } from "@/components/project/templates/projectTemplates.fixture";
import { CreateProjectRoute } from "./CreateProjectRoute";

const role = vi.hoisted(() => ({ current: "owner" }));
const createMutate = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const tier = vi.hoisted(() => ({ current: "free" }));
const me = vi.hoisted(() => ({ current: { is_staff: false } as unknown }));
const updateMutate = vi.hoisted(() => vi.fn());
const tracked = vi.hoisted(() => vi.fn());
const locale = vi.hoisted(() => ({ current: "en-US" }));
const allowance = vi.hoisted(() => ({
	calls: [] as Array<string | null | undefined>,
	data: undefined as unknown,
}));

vi.mock("@posthog/react", () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", name: "W", role: role.current, tier: tier.current },
		workspaceId: "w1",
	}),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: me.current }) }));
vi.mock("@/hooks/useFreeAllowance", () => ({
	useFreeAllowance: (id: string | null | undefined) => {
		allowance.calls.push(id);
		return { data: id ? allowance.data : undefined };
	},
}));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		opened,
		onClose,
		wallKey,
	}: {
		opened: boolean;
		onClose: () => void;
		wallKey: string;
	}) =>
		opened ? (
			<div data-testid="upgrade-modal" data-wall={wallKey}>
				<button
					type="button"
					data-testid="upgrade-modal-close"
					onClick={onClose}
				/>
			</div>
		) : null,
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: locale.current }),
}));
vi.mock("@/hooks/useWorkspaceProjects", () => ({
	useCreateWorkspaceProject: () => ({ mutateAsync: createMutate }),
}));
vi.mock("@/components/project/hooks", () => ({
	useUpdateProjectByIdMutation: () => ({ mutateAsync: updateMutate }),
}));
vi.mock("@/components/project/templates/projectTemplates", async (orig) => ({
	...(await orig<
		typeof import("@/components/project/templates/projectTemplates")
	>()),
	useProjectTemplates: () => ({ data: TEMPLATE_SUMMARIES, isError: false }),
}));
// The picker's catalog loads on open; here its English source strings are enough.
vi.mock("@/components/project/templates/i18n", () => ({
	useTemplatesCatalog: () => true,
}));
vi.mock("@/lib/analytics/events", async (orig) => ({
	...(await orig<typeof import("@/lib/analytics/events")>()),
	track: tracked,
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	role.current = "owner";
	tier.current = "free";
	me.current = { is_staff: false };
	allowance.calls = [];
	allowance.data = undefined;
	locale.current = "en-US";
	navigate.mockReset();
	createMutate.mockReset();
	updateMutate.mockReset();
	tracked.mockReset();
	vi.unstubAllGlobals();
});

const projectsMeter = (used: number, limit: number) => ({
	free: true,
	projects: { limit, used },
});

beforeAll(() => {
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

const tree = (client = new QueryClient(), url = "/w/w1/projects/new") => (
	<QueryClientProvider client={client}>
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[url]}>
					<CreateProjectRoute />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>
	</QueryClientProvider>
);

const renderCreate = (url?: string) => render(tree(new QueryClient(), url));

/** The two choices: a template card (or a quiet link), then a name. */
const chooseTemplate = (key: string) => {
	if (key === "blank") {
		fireEvent.click(screen.getByTestId("template-picker-start-blank"));
		return;
	}
	if (key === "upload") {
		fireEvent.click(screen.getByTestId("template-picker-upload"));
		return;
	}
	if (!screen.queryByTestId(`template-card-${key}`))
		fireEvent.click(screen.getByTestId("template-filter-show-all"));
	fireEvent.click(screen.getByTestId(`template-card-${key}`));
	fireEvent.click(screen.getByTestId("create-project-template-continue"));
};
const nameIt = (name: string) =>
	fireEvent.change(screen.getByLabelText("Project name"), {
		target: { value: name },
	});
const create = () =>
	fireEvent.click(screen.getByTestId("create-project-submit"));

describe("CreateProjectRoute role gating", () => {
	it.each([
		// project:create: members and admins, not outsiders
		["owner", true],
		["member", true],
		["external", false],
		["observer", false],
	])("%s: wizard shown %s", (r, canCreate) => {
		role.current = r;
		renderCreate();
		expect(!!screen.queryByTestId("template-picker")).toBe(canCreate);
		expect(!!screen.queryByTestId("create-project-not-allowed")).toBe(
			!canCreate,
		);
	});
});

describe("CreateProjectRoute free project cap", () => {
	it("opens the project wall on arrival when the free project cap is reached", () => {
		allowance.data = projectsMeter(1, 1);
		renderCreate();
		expect(screen.getByTestId("upgrade-modal").dataset.wall).toBe(
			"project_cap",
		);
	});

	it("shows the wizard without a wall when under the cap", () => {
		allowance.data = projectsMeter(0, 1);
		renderCreate();
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
		expect(screen.getByTestId("template-picker")).toBeTruthy();
	});

	it("does not fetch the allowance on a paid workspace", () => {
		tier.current = "guardian";
		allowance.data = projectsMeter(5, 1);
		renderCreate();
		expect(allowance.calls.every((id) => !id)).toBe(true);
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});

	it("never shows the up-front wall to staff", () => {
		me.current = { is_staff: true };
		allowance.data = projectsMeter(1, 1);
		renderCreate();
		expect(allowance.calls.every((id) => !id)).toBe(true);
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});

	it("closing the arrival wall returns to projects", () => {
		allowance.data = projectsMeter(1, 1);
		renderCreate();
		fireEvent.click(screen.getByTestId("upgrade-modal-close"));
		expect(navigate).toHaveBeenCalledWith("/w/w1/home");
	});

	it("does not open the wall when the cap is reached after the wizard has started", () => {
		const client = new QueryClient();
		const view = render(tree(client));
		fireEvent.click(screen.getByTestId("template-card-resident_evening"));
		allowance.data = projectsMeter(1, 1);
		view.rerender(tree(client));
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});

	it("does not open the wall after creating the last allowed project", async () => {
		allowance.data = projectsMeter(0, 1);
		createMutate.mockResolvedValue({ id: "p-new" });
		const client = new QueryClient();
		const view = render(tree(client));
		chooseTemplate("working_group");
		nameIt("Town hall");
		create();
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		// The create refreshes the allowance, which now reads at the cap.
		allowance.data = projectsMeter(1, 1);
		view.rerender(tree(client));
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});
});

describe("CreateProjectRoute: a template, then a name", () => {
	it("creates with two choices: the template goes to the server, nothing else is written", async () => {
		createMutate.mockResolvedValue({ id: "p1" });
		renderCreate();
		expect(
			screen.getByTestId("create-project-template-continue"),
		).toHaveProperty("disabled", true);
		chooseTemplate("resident_evening");
		expect(
			screen.getByTestId("create-project-chosen-template").textContent,
		).toBe("Starting from: Resident evening");
		nameIt("Town hall evening");
		create();
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith("/w/w1/projects/p1/home"),
		);
		expect(createMutate).toHaveBeenCalledWith({
			language: "en",
			name: "Town hall evening",
			templateKey: "resident_evening",
		});
		// The old wizard's PATCH would undo a preset; only typed fields are sent.
		expect(updateMutate).not.toHaveBeenCalled();
		expect(tracked).toHaveBeenCalledWith("project_template_selected", {
			featured: true,
			filters_active: [],
			setup: "many_groups",
			surface: "create",
			template_key: "resident_evening",
			verbs: ["understand", "decide"],
		});
		expect(tracked).toHaveBeenCalledWith("project_created", {
			project_id: "p1",
			template_key: "resident_evening",
		});
	});

	// The earlier screenshot showed Continue looking disabled with a card chosen.
	it("enables Continue as soon as a card is chosen, and says why it waits before", () => {
		renderCreate();
		const next = screen.getByTestId("create-project-template-continue");
		expect(next).toHaveProperty("disabled", true);
		expect(screen.getByText("Choose a card to continue.")).toBeTruthy();
		fireEvent.click(screen.getByTestId("template-card-focus_group"));
		expect(next).toHaveProperty("disabled", false);
		expect(screen.queryByText("Choose a card to continue.")).toBeNull();
	});

	it("sends the filters a host used, and each filter change, without free text", () => {
		renderCreate();
		fireEvent.click(screen.getByTestId("template-filter-verb-decide"));
		expect(tracked).toHaveBeenCalledWith("project_template_filter_changed", {
			filter: "verb",
			value: "decide",
		});
		fireEvent.click(screen.getByTestId("template-card-citizens_assembly"));
		fireEvent.click(screen.getByTestId("create-project-template-continue"));
		expect(tracked).toHaveBeenCalledWith("project_template_selected", {
			featured: false,
			filters_active: ["verb:decide"],
			setup: "many_groups",
			surface: "create",
			template_key: "citizens_assembly",
			verbs: ["decide"],
		});
	});

	it("says what the template sets up on the name step, collapsed", () => {
		renderCreate();
		chooseTemplate("resident_evening");
		const toggle = screen.getByTestId("template-setup-summary-toggle");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(
			screen.getByTestId("template-setup-summary-script").textContent,
		).toBe("Hosting a table at a resident evening");
	});

	it("notes a long project context quietly, and cuts nothing", () => {
		renderCreate();
		chooseTemplate("interviews");
		const field = screen.getByLabelText("Project context");
		fireEvent.change(field, { target: { value: "x".repeat(4000) } });
		expect(screen.queryByTestId("project-context-long-note")).toBeNull();
		fireEvent.change(field, { target: { value: "x".repeat(4001) } });
		expect(screen.getByTestId("project-context-long-note")).toBeTruthy();
		expect((field as HTMLTextAreaElement).value).toHaveLength(4001);
	});

	it("counts the new steps", () => {
		renderCreate();
		chooseTemplate("interviews");
		fireEvent.click(screen.getByTestId("create-project-more-options-toggle"));
		const steps = tracked.mock.calls
			.filter(([event]) => event === "project_create_step_viewed")
			.map(([, props]) => props.step);
		expect(steps).toEqual(["template", "name", "more_options"]);
	});

	it("starts blank from the quiet option", async () => {
		createMutate.mockResolvedValue({ id: "p2" });
		renderCreate();
		chooseTemplate("blank");
		nameIt("Anything");
		create();
		await waitFor(() => expect(createMutate).toHaveBeenCalled());
		expect(createMutate.mock.calls[0]?.[0].templateKey).toBe("blank");
	});

	it("lands on the upload page for existing recordings", async () => {
		createMutate.mockResolvedValue({ id: "p3" });
		renderCreate();
		chooseTemplate("upload");
		nameIt("Archive");
		create();
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith("/w/w1/projects/p3/upload"),
		);
	});

	it("arrives on the name step with an old key linked, which still works", () => {
		renderCreate("/w/w1/projects/new?template=series");
		expect(screen.getByLabelText("Project name")).toBeTruthy();
		expect(
			screen.getByTestId("create-project-chosen-template").textContent,
		).toBe("Starting from: A series of sessions");
	});

	it("ignores an unknown linked template and starts at the picker", () => {
		renderCreate("/w/w1/projects/new?template=festival");
		expect(screen.queryByLabelText("Project name")).toBeNull();
		expect(screen.getByTestId("template-picker")).toBeTruthy();
	});

	it.each([
		["nl-NL", "nl"],
		["de-DE", "de"],
		["cs-CZ", "cs"],
	])("creates a %s host's project in %s", async (ui, language) => {
		locale.current = ui;
		createMutate.mockResolvedValue({ id: "p4" });
		renderCreate();
		chooseTemplate("kitchen_table");
		nameIt("Gesprek");
		create();
		await waitFor(() => expect(createMutate).toHaveBeenCalled());
		expect(createMutate.mock.calls[0]?.[0].language).toBe(language);
	});
});

describe("CreateProjectRoute: More options keeps the old wizard's settings", () => {
	it("is closed by default and holds key terms, access, the review", () => {
		renderCreate();
		chooseTemplate("working_group");
		const toggle = screen.getByTestId("create-project-more-options-toggle");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		const more = screen.getByTestId("create-project-more-options");
		expect(
			more.querySelector('[data-testid="create-project-key-terms-input"]'),
		).toBeTruthy();
		expect(
			screen.getByRole("radio", { name: /Open to the workspace/ }),
		).toHaveProperty("checked", true);
		expect(screen.getByTestId("create-project-review").textContent).toContain(
			"Working group",
		);
	});

	it("writes key terms and context, and makes the project private where the tier allows", async () => {
		tier.current = "innovator";
		const fetchMock = vi.fn().mockResolvedValue({
			json: async () => ({}),
			ok: true,
		});
		vi.stubGlobal("fetch", fetchMock);
		createMutate.mockResolvedValue({ id: "p5" });
		renderCreate();
		chooseTemplate("working_group");
		nameIt("Working group");
		fireEvent.change(screen.getByLabelText(/Project context/), {
			target: { value: "Monthly meetings" },
		});
		fireEvent.click(screen.getByTestId("create-project-more-options-toggle"));
		const terms = screen.getByTestId("create-project-key-terms-input");
		fireEvent.change(terms, { target: { value: "Eindhoven, Strijp-S" } });
		fireEvent.keyDown(terms, { key: "Enter" });
		fireEvent.click(screen.getByRole("radio", { name: /^Private/ }));
		create();
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(updateMutate).toHaveBeenCalledWith({
			id: "p5",
			payload: {
				context: "Monthly meetings",
				default_conversation_transcript_prompt: "Eindhoven, Strijp-S",
			},
		});
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/v2/projects/p5/visibility"),
			expect.objectContaining({ method: "PATCH" }),
		);
		expect(tracked).toHaveBeenCalledWith("key_terms_updated", {
			count: 2,
			project_id: "p5",
			surface: "wizard",
		});
	});

	it("keeps Private out of reach on a free workspace", () => {
		renderCreate();
		chooseTemplate("working_group");
		fireEvent.click(screen.getByTestId("create-project-more-options-toggle"));
		expect(screen.getByRole("radio", { name: /^Private/ })).toHaveProperty(
			"disabled",
			true,
		);
	});
});

// ECHO-1043: "Tell dembrane about your session" in the name step.
describe("CreateProjectRoute: setup suggestions", () => {
	const suggestions = {
		key_terms: [
			{ reason: "De wijk.", source: "text", term: "Strijp-S" },
			{ reason: "De corporatie.", source: "text", term: "Woonbedrijf" },
		],
		max_key_terms: 30,
		notes: [],
		settings: [
			{
				current: false,
				field: "is_verify_enabled",
				proposed: true,
				reason: "Je wilt dat tafels afspraken bevestigen.",
			},
		],
	};
	const suggestionsFetch = (pending = false) =>
		vi.fn(async (url: string) => {
			if (String(url).includes("project-setup/suggestions")) {
				if (pending) return new Promise<Response>(() => {});
				return new Response(JSON.stringify(suggestions));
			}
			return new Response("{}");
		});

	it("sits under the project context, the one field, with its walkthrough anchor", async () => {
		renderCreate();
		chooseTemplate("resident_evening");
		const block = await screen.findByTestId("setup-suggestions");
		expect(block.getAttribute("data-tour")).toBe("setup-suggestions");
		// Name and context are the only text fields before More options.
		expect(
			screen
				.getAllByRole("textbox")
				.map(
					(el) =>
						el.getAttribute("aria-label") ??
						(el as HTMLInputElement).labels?.[0]?.textContent,
				),
		).toEqual(["Project name", "Project context"]);
		expect(
			screen.getByTestId("setup-suggestions-submit").hasAttribute("disabled"),
		).toBe(true);
	});

	it("a long pasted agenda is saved whole as the context; suggestions read its first 20,000 characters", async () => {
		const fetchMock = suggestionsFetch();
		vi.stubGlobal("fetch", fetchMock);
		createMutate.mockResolvedValue({ id: "p9" });
		updateMutate.mockResolvedValue({});
		renderCreate();
		chooseTemplate("round_table");
		nameIt("Regiotafel");
		const agenda = `Agenda ${"Evoluon Eindhoven, ".repeat(1_500)}`.trim();
		expect(agenda.length).toBeGreaterThan(20_000);
		fireEvent.change(screen.getByLabelText("Project context"), {
			target: { value: agenda },
		});
		fireEvent.click(await screen.findByTestId("setup-suggestions-submit"));
		await screen.findByTestId("setup-suggestions-results");
		const call = fetchMock.mock.calls.find(([url]) =>
			String(url).includes("project-setup/suggestions"),
		) as unknown as [string, RequestInit];
		expect(JSON.parse(String(call[1].body)).description).toHaveLength(20_000);
		expect(screen.getByTestId("setup-suggestions-long-note")).toBeTruthy();
		create();
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(updateMutate).toHaveBeenCalledWith({
			id: "p9",
			payload: { context: agenda },
		});
	});

	it("never blocks Create: it stays enabled while suggestions load", async () => {
		vi.stubGlobal("fetch", suggestionsFetch(true));
		createMutate.mockResolvedValue({ id: "p7" });
		renderCreate();
		chooseTemplate("resident_evening");
		nameIt("Bewonersavond");
		fireEvent.change(screen.getByLabelText("Project context"), {
			target: { value: "Met Woonbedrijf in Strijp-S" },
		});
		fireEvent.click(screen.getByTestId("setup-suggestions-submit"));
		await screen.findByText(/Reading what you wrote/);
		expect(screen.getByTestId("create-project-submit")).toHaveProperty(
			"disabled",
			false,
		);
		create();
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith("/w/w1/projects/p7/home"),
		);
	});

	it("accepted terms go into the key terms, ticked settings ride on the create as overrides", async () => {
		vi.stubGlobal("fetch", suggestionsFetch());
		createMutate.mockResolvedValue({ id: "p8" });
		updateMutate.mockResolvedValue({});
		renderCreate();
		chooseTemplate("blank");
		nameIt("Bewonersavond");
		fireEvent.change(screen.getByLabelText("Project context"), {
			target: { value: "Met Woonbedrijf in Strijp-S" },
		});
		fireEvent.click(screen.getByTestId("setup-suggestions-submit"));
		await screen.findByTestId("setup-suggestions-results");
		fireEvent.click(screen.getByRole("button", { name: "Strijp-S" }));
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Participant verification" }),
		);
		// The key terms field shows the accepted term and stays editable.
		fireEvent.click(screen.getByTestId("create-project-more-options-toggle"));
		expect(
			screen.getByTestId("create-project-more-options").textContent,
		).toContain("Strijp-S");
		create();
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(createMutate).toHaveBeenCalledWith({
			language: "en",
			name: "Bewonersavond",
			overrides: { is_verify_enabled: true },
			templateKey: "blank",
		});
		expect(updateMutate).toHaveBeenCalledWith({
			id: "p8",
			payload: {
				context: "Met Woonbedrijf in Strijp-S",
				default_conversation_transcript_prompt: "Strijp-S",
			},
		});
		expect(tracked).toHaveBeenCalledWith("project_setup_ai_accepted", {
			settings_accepted: 1,
			surface: "wizard",
			terms_accepted: 1,
		});
	});
});
