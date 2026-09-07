// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { OrgAgentAccess } from "./hooks";
import { OrgAgentAccessPanel } from "./OrgAgentAccessPanel";

vi.mock("posthog-js", () => ({
	default: { capture: () => {} },
}));

const ORG: OrgAgentAccess = {
	agent_access_enabled: true,
	calls_this_month: 12,
	can_manage: true,
	id: "org-1",
	is_paid: false,
	monthly_limit: 1000,
	name: "Managed BV",
	role: "admin",
	updated_at: null,
};

vi.mock("./hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./hooks")>();
	return {
		...actual,
		useAgentOrganisationsQuery: () => ({ data: [ORG], isLoading: false }),
		useOrgAgentAuditQuery: () => ({ data: [], isLoading: false }),
		useOrgAgentGrantsQuery: () => ({ data: [], isLoading: false }),
		useRevokeAgentGrantMutation: () => ({ isPending: false, mutate: vi.fn() }),
		useSetOrgAgentAccessMutation: () => ({
			isPending: false,
			mutate: vi.fn(),
			variables: undefined,
		}),
	};
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");

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
});

const wrap = () =>
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/o/org-1/settings/agents"]}>
						<OrgAgentAccessPanel orgId="org-1" orgName="Managed BV" />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

it("points the callout at the Connect page", () => {
	wrap();

	const callout = screen.getByTestId("agent-org-scope-callout");
	expect(callout.textContent).toContain("This page is about Managed BV only.");
	const link = screen.getByTestId("agent-org-connect-link");
	expect(link.textContent).toBe("Connect your agent");
	expect(link.getAttribute("href")).toMatch(/\/connect-agent$/);
});

it("shows the three sections under the title", () => {
	wrap();

	expect(
		screen.getByRole("heading", { level: 3, name: "MCP access" }),
	).toBeTruthy();
	for (const name of ["This organisation", "Connected agents", "Activity"]) {
		expect(screen.getByRole("heading", { level: 5, name })).toBeTruthy();
	}
	expect(screen.queryByText("Recent activity")).toBeNull();
});

it("shows this organisation as one row with the switch and the calls line", () => {
	wrap();

	const row = screen.getByTestId("agent-org-org-1");
	expect(row.textContent).toContain("Managed BV");
	expect(screen.getByTestId("agent-org-status-org-1").textContent).toBe("On");
	const toggle = screen.getByTestId("agent-access-switch-org-1");
	expect(toggle.getAttribute("aria-label")).toBe(
		"Allow MCP access in Managed BV",
	);
	expect(
		screen.getByText("12 of 1000 calls this month (free plan)"),
	).toBeTruthy();
	expect(screen.getByText("No agents connected yet.")).toBeTruthy();
	expect(screen.getByText("No agent calls yet.")).toBeTruthy();
});
