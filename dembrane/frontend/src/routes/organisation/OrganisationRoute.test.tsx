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
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { OrganisationRoute } from "./OrganisationRoute";

const { none, setWorkspace, myWorkspaces } = vi.hoisted(() => ({
	myWorkspaces: [] as { id: string; org_id: string; role: string }[],
	none: () => null,
	setWorkspace: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: { capture: () => {} } }));
vi.mock("@/hooks/useI18nNavigate", async () => {
	const { useNavigate } = await import("react-router");
	return { useI18nNavigate: () => useNavigate() };
});
vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({ data: { id: "app-me" } }),
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ setWorkspace, workspaces: myWorkspaces }),
}));
vi.mock("@/features/accounts/help/tasksSummary", () => ({
	useTasksSummary: () => ({ data: [] }),
}));
// Panels with their own data, out of scope here.
vi.mock("@/components/agent-access/OrgAgentAccessPanel", () => ({
	OrgAgentAccessPanel: none,
}));
vi.mock("@/components/billing/BillingManager", () => ({ OrgBillingTab: none }));
vi.mock("@/components/invite/InviteModal", () => ({ InviteModal: none }));
vi.mock("@/components/training", () => ({ OrgTrainingPanel: none }));
vi.mock("@/components/workspace/DiscoverableWorkspaces", () => ({
	DiscoverableWorkspaces: none,
}));
vi.mock("@/components/workspace/OrganisationUsageRollup", () => ({
	OrganisationUsageRollup: none,
}));

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	};
});

const NOW = new Date(2026, 10, 18, 12);
const hoursAgo = (h: number) =>
	new Date(NOW.getTime() - h * 3600_000).toISOString();

const person = (
	app_user_id: string,
	display_name: string,
	role: string,
	is_external = false,
) => ({
	accessible_workspace_count: 0,
	app_user_id,
	avatar: null,
	display_name,
	email: `${display_name.toLowerCase()}@example.com`,
	is_external,
	is_pending: false,
	role,
	user_id: `u-${app_user_id}`,
});

const myWs = (
	id: string,
	name: string,
	tier: string,
	created_at: string,
	org_id = "o1",
) => ({
	created_at,
	id,
	member_count: 1,
	name,
	org_id,
	project_count: 0,
	role: "admin",
	tier,
});

const responses: Record<string, unknown> = {
	"/v2/orgs/o1": {
		description: null,
		external_count: 1,
		id: "o1",
		logo_url: null,
		member_count: 3,
		name: "Field Org",
		role: "admin",
		workspace_count: 3,
	},
	"/v2/orgs/o1/billing": { tier: "pro" },
	"/v2/orgs/o1/members": [
		person("app-zed", "Zed", "member"),
		person("app-eve", "Eve", "member", true),
		person("app-me", "Ada", "admin"),
	],
	"/v2/orgs/o1/workspaces": [],
	"/v2/workspaces": {
		workspaces: [
			myWs("w-old", "Older", "pro", hoursAgo(48)),
			myWs("w-new", "Brand new", "pro", hoursAgo(2)),
			myWs("w-free", "Free one", "free", hoursAgo(2)),
			myWs("w-other", "Elsewhere", "pro", hoursAgo(2), "o2"),
		],
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	myWorkspaces.length = 0;
	vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
	vi.setSystemTime(NOW);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://x").pathname.replace(
				/^.*?\/v2\//,
				"/v2/",
			);
			return new Response(
				JSON.stringify(responses[path] ?? (path.includes("invite") ? [] : {})),
				{
					headers: { "Content-Type": "application/json" },
					status: 200,
				},
			);
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function Where() {
	const { pathname, search } = useLocation();
	return <output data-testid="where">{pathname + search}</output>;
}

const show = (at: string) =>
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={[at]}>
						<Where />
						<Routes>
							<Route
								path="/o/:organisationId/*"
								element={<OrganisationRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

const where = () => screen.getByTestId("where").textContent;

describe("OrganisationRoute", () => {
	it("sends bare, /billing and /people URLs to their canonical place", async () => {
		show("/o/o1");
		await waitFor(() => expect(where()).toBe("/o/o1/overview"));
		cleanup();
		show("/o/o1/billing");
		await waitFor(() => expect(where()).toBe("/o/o1/settings/billing"));
		cleanup();
		show("/o/o1/people?search=ze");
		await waitFor(() => expect(where()).toBe("/o/o1/members?search=ze"));
	});

	it("shows this organisation's workspaces by name, marking a paid one approved today as New", async () => {
		show("/o/o1/overview");
		await screen.findByText("Brand new");
		const names = ["Brand new", "Free one", "Older"].map((n) =>
			screen.getByText(n),
		);
		for (let i = 1; i < names.length; i++) {
			expect(
				names[i - 1].compareDocumentPosition(names[i]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		}
		expect(screen.queryByText("Elsewhere")).toBeNull();
		expect(screen.getAllByText("New")).toHaveLength(1);
	});

	it("opens a workspace from its card", async () => {
		show("/o/o1/overview");
		fireEvent.click(await screen.findByText("Older"));
		expect(setWorkspace).toHaveBeenCalledWith("w-old");
		await waitFor(() => expect(where()).toBe("/w/w-old/home"));
	});

	it("lists you first, and filters members by role and search", async () => {
		show("/o/o1/members");
		const rows = async () =>
			(await screen.findAllByText(/^(Ada|Eve|Zed)$/)).map((n) => n.textContent);
		await waitFor(async () =>
			expect(await rows()).toEqual(["Ada", "Zed", "Eve"]),
		);

		fireEvent.click(screen.getByRole("radio", { name: "Externals" }));
		await waitFor(async () => expect(await rows()).toEqual(["Eve"]));
		fireEvent.click(screen.getByRole("radio", { name: "All" }));

		fireEvent.change(screen.getByPlaceholderText("Search name or email"), {
			target: { value: "ze" },
		});
		await waitFor(async () => expect(await rows()).toEqual(["Zed"]));
		expect(where()).toBe("/o/o1/members?search=ze");
	});
});
