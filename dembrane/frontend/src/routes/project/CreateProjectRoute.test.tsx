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

/** The two choices: a template card (or blank), then a name. */
const chooseTemplate = (key: string) => {
	if (key === "blank") {
		fireEvent.click(screen.getByTestId("template-picker-start-blank"));
		return;
	}
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
		fireEvent.click(screen.getByTestId("template-card-event"));
		allowance.data = projectsMeter(1, 1);
		view.rerender(tree(client));
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});

	it("does not open the wall after creating the last allowed project", async () => {
		allowance.data = projectsMeter(0, 1);
		createMutate.mockResolvedValue({ id: "p-new" });
		const client = new QueryClient();
		const view = render(tree(client));
		chooseTemplate("series");
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
		chooseTemplate("event");
		expect(
			screen.getByTestId("create-project-chosen-template").textContent,
		).toBe("Starting from: A live event");
		nameIt("Town hall evening");
		create();
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith("/w/w1/projects/p1/home"),
		);
		expect(createMutate).toHaveBeenCalledWith({
			language: "en",
			name: "Town hall evening",
			templateKey: "event",
		});
		// The old wizard's PATCH would undo a preset; only typed fields are sent.
		expect(updateMutate).not.toHaveBeenCalled();
		expect(tracked).toHaveBeenCalledWith("project_template_selected", {
			surface: "create",
			template_key: "event",
		});
		expect(tracked).toHaveBeenCalledWith("project_created", {
			project_id: "p1",
			template_key: "event",
		});
	});

	it("counts the new steps", () => {
		renderCreate();
		chooseTemplate("conversation");
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

	it("arrives on the name step with a template linked from workspace home", () => {
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
		chooseTemplate("conversation");
		nameIt("Gesprek");
		create();
		await waitFor(() => expect(createMutate).toHaveBeenCalled());
		expect(createMutate.mock.calls[0]?.[0].language).toBe(language);
	});
});

describe("CreateProjectRoute: More options keeps the old wizard's settings", () => {
	it("is closed by default and holds key terms, access, the review", () => {
		renderCreate();
		chooseTemplate("series");
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
			"A series of sessions",
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
		chooseTemplate("series");
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
		chooseTemplate("series");
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

	it("sits in the name step, optional, with its walkthrough anchor", async () => {
		renderCreate();
		chooseTemplate("event");
		const block = await screen.findByTestId("setup-suggestions");
		expect(block.getAttribute("data-tour")).toBe("setup-suggestions");
		expect(screen.getByText("Tell dembrane about your session")).toBeTruthy();
	});

	it("never blocks Create: it stays enabled while suggestions load", async () => {
		vi.stubGlobal("fetch", suggestionsFetch(true));
		createMutate.mockResolvedValue({ id: "p7" });
		renderCreate();
		chooseTemplate("event");
		nameIt("Bewonersavond");
		fireEvent.change(await screen.findByLabelText("About your session"), {
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
		chooseTemplate("conversation");
		nameIt("Bewonersavond");
		fireEvent.change(await screen.findByLabelText("About your session"), {
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
			templateKey: "conversation",
		});
		expect(updateMutate).toHaveBeenCalledWith({
			id: "p8",
			payload: { default_conversation_transcript_prompt: "Strijp-S" },
		});
		expect(tracked).toHaveBeenCalledWith("project_setup_ai_accepted", {
			settings_accepted: 1,
			surface: "wizard",
			terms_accepted: 1,
		});
	});
});
