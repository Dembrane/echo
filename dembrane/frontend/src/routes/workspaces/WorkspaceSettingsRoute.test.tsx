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
	within,
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
import { WorkspaceSettingsRoute } from "./WorkspaceSettingsRoute";

vi.mock("posthog-js", () => ({ default: { capture: () => {} } }));
// The route's own navigation, without the language prefix.
vi.mock("@/hooks/useI18nNavigate", async () => {
	const { useNavigate } = await import("react-router");
	return { useI18nNavigate: () => useNavigate() };
});
vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({ data: { id: "u-me" } }),
}));
let workspaceSummary: { role: string; project_count: number } = {
	project_count: 0,
	role: "admin",
};
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: workspaceSummary }),
}));
vi.mock("@/components/members/hooks", async (original) => ({
	...(await original<object>()),
	usePendingInvites: () => ({ data: [] }),
}));
// Sections with their own data, out of scope here.
const { none } = vi.hoisted(() => ({ none: () => null }));
vi.mock("@/components/billing/BillingManager", () => ({
	BillingManager: none,
	OrgManagedBillingNotice: none,
}));
vi.mock("@/components/invite/InviteModal", () => ({ InviteModal: none }));
vi.mock("@/components/memory/WorkspaceMemorySection", () => ({
	WorkspaceMemorySection: none,
}));
vi.mock("@/components/methodology/WorkspaceMethodologiesSection", () => ({
	WorkspaceMethodologiesSection: none,
}));
vi.mock("@/components/training", () => ({ WorkspaceTrainingPanel: none }));
vi.mock("@/components/workspace/AccessRequestsList", () => ({
	AccessRequestsList: none,
}));
vi.mock("@/components/workspace/FreeAllowanceCard", () => ({
	FreeAllowanceCard: none,
}));
vi.mock("@/components/workspace/SupportAccessSection", () => ({
	SupportAccessSection: none,
}));
vi.mock("@/components/workspace/UsageCard", () => ({ UsageCard: none }));
vi.mock("@/components/workspace/WorkspaceDataOwnershipSection", () => ({
	WorkspaceDataOwnershipSection: none,
}));
vi.mock("@/components/workspace/WorkspaceLegalBasisSection", () => ({
	WorkspaceLegalBasisSection: none,
}));

i18n.loadAndActivate({ locale: "en-US", messages: {} });

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

const member = (id: string, display_name: string, role: string) => ({
	avatar: null,
	display_name,
	email: `${display_name.toLowerCase()}@example.com`,
	id,
	role,
	source: "direct",
	user_id: id === "m-me" ? "u-me" : `u-${id}`,
});

const settings = (my_role: string, my_policies: string[]) => ({
	allow_support_access: false,
	billing_account_id: null,
	billing_org_managed: false,
	billing_period: null,
	billing_status: null,
	context: null,
	data_owner_email: null,
	data_owner_org_name: null,
	description: null,
	id: "w1",
	inherit_organisation_members: true,
	is_default: false,
	is_external_client: false,
	legal_basis: null,
	logo_url: null,
	members: [
		member("m-zed", "Zed", "member"),
		member("m-ext", "Eve", "external"),
		member("m-me", "Ada", "admin"),
		member("m-bil", "Bo", "billing"),
	],
	my_policies,
	my_role,
	name: "Field Lab",
	org_id: "o1",
	org_name: "Org",
	pending_invites: [],
	percent_discount: null,
	privacy_policy_url: null,
	tier: "pro",
	type_discount: null,
	usage_context: null,
	visibility: "open_to_organisation",
});

const ADMIN = ["member:manage", "settings:manage"];
let current = settings("admin", ADMIN);

beforeEach(() => {
	current = settings("admin", ADMIN);
	workspaceSummary = { project_count: 0, role: "admin" };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = url.endsWith("/settings")
				? current
				: url.includes("/usage")
					? {
							member_count: 4,
							seat_count: 3,
							seat_count_included: null,
							tier: "pro",
						}
					: {};
			return new Response(JSON.stringify(body), {
				headers: { "Content-Type": "application/json" },
				status: 200,
			});
		}),
	);
});

afterEach(() => {
	cleanup();
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
								path="/w/:workspaceId/settings/*"
								element={<WorkspaceSettingsRoute />}
							/>
							<Route
								path="/w/:workspaceId/members"
								element={<WorkspaceSettingsRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

const where = () => screen.getByTestId("where").textContent;
const names = () =>
	screen
		.getAllByText(/^(Ada|Bo|Eve|Zed)/)
		.map((n) => n.textContent?.replace(" (You)", ""));

describe("WorkspaceSettingsRoute", () => {
	it("opens an admin on General, and a billing contact on Billing", async () => {
		show("/w/w1/settings");
		await waitFor(() => expect(where()).toBe("/w/w1/settings/general"));
		cleanup();

		current = settings("billing", []);
		show("/w/w1/settings");
		await waitFor(() => expect(where()).toBe("/w/w1/settings/billing"));
	});

	it("moves /settings/members to /members, keeping the search", async () => {
		show("/w/w1/settings/members?search=ze");
		await waitFor(() => expect(where()).toBe("/w/w1/members?search=ze"));
	});

	it("lists members by role, externals last, and filters them", async () => {
		show("/w/w1/members");
		await waitFor(() => expect(names()).toEqual(["Ada", "Bo", "Zed", "Eve"]));

		fireEvent.click(screen.getByRole("radio", { name: "Externals" }));
		await waitFor(() => expect(names()).toEqual(["Eve"]));
		fireEvent.click(screen.getByRole("radio", { name: "All" }));

		fireEvent.change(screen.getByPlaceholderText("Search name or email"), {
			target: { value: "ze" },
		});
		await waitFor(() => expect(names()).toEqual(["Zed"]));
		expect(where()).toBe("/w/w1/members?search=ze");
	});

	it("deletes only once the workspace's name is typed", async () => {
		show("/w/w1/settings/danger");
		const button = await screen.findByRole("button", {
			name: "Delete workspace",
		});
		expect((button as HTMLButtonElement).disabled).toBe(true);
		const field = screen.getByPlaceholderText("Field Lab");
		fireEvent.change(field, { target: { value: "Field La" } });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(field, { target: { value: "Field Lab" } });
		expect((button as HTMLButtonElement).disabled).toBe(false);
	});

	it("asks for the projects to go first when the workspace has some", async () => {
		workspaceSummary = { project_count: 2, role: "admin" };
		show("/w/w1/settings/danger");
		const panel = await screen.findByText("Delete this workspace");
		expect(
			within(panel.closest("div") as HTMLElement).queryByRole("button"),
		).toBeNull();
		expect(
			await screen.findByText(/Delete the 2 projects in this workspace/),
		).toBeTruthy();
	});
});
