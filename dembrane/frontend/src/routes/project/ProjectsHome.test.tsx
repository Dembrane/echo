// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEMPLATE_SUMMARIES } from "@/components/project/templates/projectTemplates.fixture";
import { ProjectsHomeRoute } from "./ProjectsHome";

const navigate = vi.hoisted(() => vi.fn());
const tracked = vi.hoisted(() => vi.fn());
const role = vi.hoisted(() => ({ current: "owner" }));
const projects = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@formkit/auto-animate/react", () => ({
	useAutoAnimate: () => [null],
}));
vi.mock("react-intersection-observer", () => ({
	useInView: () => ({ inView: false, ref: () => {} }),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/components/auth/hooks", () => ({
	useCurrentUser: () => ({ data: {} }),
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: {
			id: "w1",
			member_count: 1,
			name: "Mine",
			role: role.current,
			tier: "free",
		},
		workspaceId: "w1",
	}),
}));
vi.mock("@/hooks/useProjectCap", () => ({ useProjectCap: () => false }));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: () => null,
}));
vi.mock("@/components/project/hooks", () => ({
	useTogglePinMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/components/project/ProjectListItem", () => ({
	ProjectListItem: ({ project }: { project: { name: string } }) => (
		<div data-testid="project-row">{project.name}</div>
	),
}));
vi.mock("@/components/project/BulkMoveProjectsModal", () => ({
	BulkMoveProjectsModal: () => null,
}));
vi.mock("@/hooks/useWorkspaceProjects", () => ({
	useWorkspaceProjects: () => ({
		data: {
			pages: [{ is_admin: true, pinned: [], projects: projects.current }],
		},
		error: null,
		fetchNextPage: vi.fn(),
		hasNextPage: false,
		isError: false,
		isFetchingNextPage: false,
		status: "success",
	}),
}));
vi.mock("@/components/project/templates/projectTemplates", async (orig) => ({
	...(await orig<
		typeof import("@/components/project/templates/projectTemplates")
	>()),
	useProjectTemplates: () => ({ data: TEMPLATE_SUMMARIES, isError: false }),
}));
vi.mock("@/components/project/templates/i18n", () => ({
	useTemplatesCatalog: () => true,
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));
vi.mock("@/lib/analytics/events", async (orig) => ({
	...(await orig<typeof import("@/lib/analytics/events")>()),
	track: tracked,
}));

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia ||= ((query: string) =>
		({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}) as unknown as MediaQueryList) as typeof window.matchMedia;
});

afterEach(() => {
	cleanup();
	navigate.mockReset();
	tracked.mockReset();
	role.current = "owner";
	projects.current = [];
});

const sample = { id: "s1", is_sample: true, name: "Best practices (sample)" };
const own = { id: "p1", is_sample: false, name: "Town hall" };

const renderHome = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter>
						<ProjectsHomeRoute />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

describe("workspace home for a host with no project of their own", () => {
	it.each([
		["no projects at all", []],
		["only the sample", [sample]],
	])(
		"with %s, the template picker is the one primary action",
		async (_, list) => {
			projects.current = list;
			renderHome();
			expect(screen.getByTestId("workspace-home-start")).toBeTruthy();
			// Loaded on its own, only here.
			expect(await screen.findByTestId("template-picker")).toBeTruthy();
			// One create button, waiting for a card.
			const create = screen.getAllByTestId("project-home-create-button");
			expect(create).toHaveLength(1);
			expect(create[0]).toHaveProperty("disabled", true);
			expect(screen.getByText(/Your projects will appear here/)).toBeTruthy();
		},
	);

	it("continues to the name step with the chosen template", async () => {
		projects.current = [sample];
		renderHome();
		fireEvent.click(
			await screen.findByTestId("template-card-resident_evening"),
		);
		fireEvent.click(screen.getByTestId("project-home-create-button"));
		expect(navigate).toHaveBeenCalledWith(
			"/w/w1/projects/new?template=resident_evening",
		);
		expect(tracked).toHaveBeenCalledWith("project_template_selected", {
			featured: true,
			filters_active: [],
			setup: "many_groups",
			surface: "workspace_home",
			template_key: "resident_evening",
			verbs: ["understand", "decide"],
		});
	});

	it("starts blank or uploads from the quiet links", async () => {
		renderHome();
		fireEvent.click(await screen.findByTestId("template-picker-start-blank"));
		expect(navigate).toHaveBeenCalledWith("/w/w1/projects/new?template=blank");
		fireEvent.click(screen.getByTestId("template-picker-upload"));
		expect(navigate).toHaveBeenCalledWith("/w/w1/projects/new?template=upload");
	});

	it("shows the list as before once the host has a project", () => {
		projects.current = [own, sample];
		renderHome();
		expect(screen.queryByTestId("workspace-home-start")).toBeNull();
		expect(screen.getAllByTestId("project-home-create-button")).toHaveLength(1);
	});

	it("does not offer the picker to someone who cannot create", () => {
		role.current = "observer";
		renderHome();
		expect(screen.queryByTestId("workspace-home-start")).toBeNull();
		expect(screen.getByText("Nothing here for you yet.")).toBeTruthy();
	});
});
