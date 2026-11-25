// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectsHomeRoute } from "./ProjectsHome";

const navigate = vi.hoisted(() => vi.fn());
const tracked = vi.hoisted(() => vi.fn());
const role = vi.hoisted(() => ({ current: "owner" }));
const projects = vi.hoisted(() => ({ current: [] as unknown[] }));
const atCap = vi.hoisted(() => ({ current: false }));

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
vi.mock("@/hooks/useProjectCap", () => ({
	useProjectCap: () => atCap.current,
}));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({ opened }: { opened: boolean }) =>
		opened ? <div data-testid="upgrade-modal" /> : null,
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
	atCap.current = false;
});

const sample = { id: "s1", is_sample: true, name: "Best practices (sample)" };
const own = { id: "p1", is_sample: false, name: "Town hall" };

const renderHome = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider env="test">
					<MemoryRouter>
						<ProjectsHomeRoute />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

const openCreate = () => {
	fireEvent.click(screen.getByTestId("create-menu-button"));
	return screen.getAllByRole("menuitem").map((el) => el.textContent?.trim());
};

describe("workspace home's Create menu", () => {
	it.each([
		["no projects at all", []],
		["only the sample", [sample]],
		["projects of their own", [own, sample]],
	])(
		"with %s, sits on the All projects row above the search, with the project items only",
		(_, list) => {
			projects.current = list;
			renderHome();
			const button = screen.getByTestId("create-menu-button");
			expect(button.closest(".mantine-Group-root")?.textContent).toContain(
				"All projects",
			);
			expect(
				button.compareDocumentPosition(
					screen.getByTestId("project-search-input"),
				) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(screen.getAllByTestId("create-menu-button")).toHaveLength(1);
			expect(openCreate()).toEqual([
				"Quick project",
				"Project from a template",
			]);
			// The old start block is gone.
			expect(
				screen.queryByText("Let's hear your first conversation."),
			).toBeNull();
			expect(screen.queryByTestId("template-picker")).toBeNull();
		},
	);

	it("starts a Quick project here: counts it as Quick start and goes to the name", () => {
		renderHome();
		openCreate();
		fireEvent.click(screen.getByTestId("create-menu-quick-project"));
		expect(tracked).toHaveBeenCalledWith("project_create_started");
		expect(tracked).toHaveBeenCalledWith("project_template_selected", {
			featured: false,
			filters_active: [],
			setup: null,
			surface: "workspace_home",
			template_key: "blank",
			verbs: [],
		});
		expect(navigate).toHaveBeenCalledWith("/w/w1/projects/new?template=blank");
	});

	it("goes to the template screen for a project from a template", () => {
		projects.current = [own];
		renderHome();
		openCreate();
		fireEvent.click(screen.getByTestId("create-menu-template-project"));
		expect(tracked).toHaveBeenCalledWith("project_create_started");
		expect(tracked).not.toHaveBeenCalledWith(
			"project_template_selected",
			expect.anything(),
		);
		expect(navigate).toHaveBeenCalledWith("/w/w1/projects/new");
	});

	it("at the free project cap opens the wall instead of the menu", () => {
		atCap.current = true;
		renderHome();
		fireEvent.click(screen.getByTestId("create-menu-button"));
		expect(screen.queryByRole("menuitem")).toBeNull();
		expect(screen.getByTestId("upgrade-modal")).toBeTruthy();
		expect(screen.getByTestId("unavailable-info")).toBeTruthy();
		expect(navigate).not.toHaveBeenCalled();
	});
});

describe("an empty workspace", () => {
	it("shows the row, the search and one quiet line where the list would be", () => {
		renderHome();
		expect(screen.getByTestId("create-menu-button")).toBeTruthy();
		expect(screen.getByTestId("project-search-input")).toBeTruthy();
		expect(screen.getByText(/Your projects will appear here/)).toBeTruthy();
		expect(screen.queryAllByTestId("project-row")).toHaveLength(0);
	});

	it("does not show the quiet line once there is a project, the sample included", () => {
		projects.current = [sample];
		renderHome();
		expect(screen.queryByText(/Your projects will appear here/)).toBeNull();
		expect(screen.getAllByTestId("project-row")).toHaveLength(1);
	});

	it("tells a guest nothing is shared yet, with no Create", () => {
		role.current = "observer";
		renderHome();
		expect(screen.getByText("Nothing here for you yet.")).toBeTruthy();
		expect(screen.queryByTestId("create-menu-button")).toBeNull();
		expect(screen.queryByTestId("project-search-input")).toBeNull();
	});
});
