// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkspaceSelectorRoute } from "./WorkspaceSelectorRoute";

const navigate = vi.hoisted(() => vi.fn());
const tracked = vi.hoisted(() => vi.fn());
const setWorkspace = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
	orgs: [{ id: "o1", name: "Atelier", role: "owner" }] as {
		id: string;
		name: string;
		role: string;
	}[],
	workspaces: [] as {
		id: string;
		name: string;
		org_id: string;
		org_name: string;
		role: string;
	}[],
}));

vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({ data: { display_name: "Sam Jansen", orgs: state.orgs } }),
}));
vi.mock("@/hooks/useMyInvites", () => ({ useMyInvites: () => ({ data: [] }) }));
vi.mock("@/hooks/useManagedFreeOrg", () => ({ useManagedFreeOrg: () => null }));
vi.mock("@/components/auth/hooks", () => ({
	useCurrentUser: () => ({ data: {} }),
}));
vi.mock("@/features/sidebar/hooks/useSearchHits", () => ({
	useSearchHits: () => ({ hits: [], isFetching: false }),
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		setWorkspace,
		workspaceId: null,
		workspaces: state.workspaces,
	}),
}));
vi.mock("@/components/organisation/CreateOrganisationModal", () => ({
	CreateOrganisationModal: ({ opened }: { opened: boolean }) =>
		opened ? <div data-testid="create-org-modal" /> : null,
}));
vi.mock("@/lib/analytics/events", async (orig) => ({
	...(await orig<typeof import("@/lib/analytics/events")>()),
	track: tracked,
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
	globalThis.ResizeObserver ||= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});

afterEach(() => {
	cleanup();
	navigate.mockReset();
	tracked.mockReset();
	setWorkspace.mockReset();
	state.orgs = [{ id: "o1", name: "Atelier", role: "owner" }];
	vi.unstubAllGlobals();
});

const ws = (id: string, name: string, role = "owner") => ({
	id,
	name,
	org_id: "o1",
	org_name: "Atelier",
	role,
});

const renderHome = () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			json: async () => ({
				organisations: [
					{
						id: "o1",
						logo_url: null,
						name: "Atelier",
						role: state.orgs[0]?.role ?? "owner",
						total_members: 2,
						workspace_count: state.workspaces.length,
					},
				],
				recent_removals: [],
				workspaces: state.workspaces,
			}),
			ok: true,
		})),
	);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider env="test">
					<MemoryRouter>
						<WorkspaceSelectorRoute />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);
};

describe("Home's Create menu", () => {
	it("sits on the line above the search box", async () => {
		state.workspaces = [ws("w1", "Team")];
		renderHome();
		const button = await screen.findByTestId("create-menu-button");
		expect(button.closest(".mantine-Group-root")?.textContent).toContain(
			"Where would you like to go?",
		);
		const search = screen.getByRole("combobox");
		expect(
			button.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("starts a Quick project in the one workspace: selects it, counts it, goes to the name", async () => {
		state.workspaces = [ws("w1", "Team")];
		renderHome();
		fireEvent.click(await screen.findByTestId("create-menu-button"));
		fireEvent.click(screen.getByTestId("create-menu-quick-project"));
		expect(setWorkspace).toHaveBeenCalledWith("w1");
		expect(tracked).toHaveBeenCalledWith("project_create_started");
		expect(tracked).toHaveBeenCalledWith("project_template_selected", {
			featured: false,
			filters_active: [],
			setup: null,
			surface: "home",
			template_key: "blank",
			verbs: [],
		});
		expect(navigate).toHaveBeenCalledWith("/w/w1/projects/new?template=blank");
	});

	it("asks which workspace for a project from a template, then goes to the template screen", async () => {
		state.workspaces = [ws("w1", "Team"), ws("w2", "Lab")];
		renderHome();
		fireEvent.click(await screen.findByTestId("create-menu-button"));
		fireEvent.click(screen.getByTestId("create-menu-template-project"));
		expect(navigate).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId("which-workspace-w2"));
		expect(setWorkspace).toHaveBeenCalledWith("w2");
		expect(tracked).toHaveBeenCalledWith("project_create_started");
		expect(tracked).not.toHaveBeenCalledWith(
			"project_template_selected",
			expect.anything(),
		);
		expect(navigate).toHaveBeenCalledWith("/w/w2/projects/new");
	});

	it("leaves out the project items for an outsider, and Workspace for an organisation member", async () => {
		state.workspaces = [ws("w1", "Shared with me", "external")];
		state.orgs = [{ id: "o1", name: "Atelier", role: "member" }];
		renderHome();
		fireEvent.click(await screen.findByTestId("create-menu-button"));
		expect(
			screen.getAllByRole("menuitem").map((el) => el.textContent?.trim()),
		).toEqual(["Organisation"]);
	});

	it("goes to the workspace wizard, and opens the organisation dialog in place", async () => {
		state.workspaces = [ws("w1", "Team")];
		renderHome();
		fireEvent.click(await screen.findByTestId("create-menu-button"));
		fireEvent.click(screen.getByTestId("create-menu-workspace"));
		expect(navigate).toHaveBeenCalledWith("/w/new");
		fireEvent.click(screen.getByTestId("create-menu-button"));
		fireEvent.click(screen.getByTestId("create-menu-organisation"));
		expect(screen.getByTestId("create-org-modal")).toBeTruthy();
	});
});
