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
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { OrgAgentAccess } from "./hooks";
import { YourOrganisations } from "./YourOrganisations";

vi.mock("posthog-js", () => ({
	default: { capture: () => {} },
}));

const ORG_ON_MEMBER: OrgAgentAccess = {
	agent_access_enabled: true,
	calls_this_month: 0,
	can_manage: false,
	id: "org-on",
	is_paid: false,
	monthly_limit: null,
	name: "Facilitation BV",
	role: "member",
	updated_at: null,
};

const ORG_ON_ADMIN: OrgAgentAccess = {
	...ORG_ON_MEMBER,
	can_manage: true,
	id: "org-on-admin",
	name: "Managed BV",
	role: "admin",
};

const ORG_OFF_MEMBER: OrgAgentAccess = {
	...ORG_ON_MEMBER,
	agent_access_enabled: false,
	id: "org-off",
	name: "Other BV",
};

const ORG_OFF_ADMIN: OrgAgentAccess = {
	...ORG_OFF_MEMBER,
	can_manage: true,
	id: "org-admin",
	name: "Admin BV",
	role: "admin",
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

const mockFetch = (organisations: OrgAgentAccess[]) => {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.endsWith("/agent-access/organisations") && method === "GET") {
				return json(organisations);
			}
			const toggled = organisations.find(
				(org) =>
					url.endsWith(`/agent-access/organisations/${org.id}`) &&
					method === "PATCH",
			);
			if (toggled) return json({ ...toggled, agent_access_enabled: true });
			return json({}, 404);
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
};

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
	vi.unstubAllGlobals();
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
					<MemoryRouter initialEntries={["/connect-agent"]}>
						<YourOrganisations />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

it("shows On with a Manage link for an organisation the user manages", async () => {
	mockFetch([ORG_ON_ADMIN]);
	wrap();

	const row = await screen.findByTestId("agent-org-org-on-admin");
	expect(row.textContent).toContain("Managed BV");
	expect(screen.getByTestId("agent-org-status-org-on-admin").textContent).toBe(
		"On",
	);
	const manage = screen.getByTestId("agent-org-manage-org-on-admin");
	expect(manage.textContent).toBe("Manage");
	expect(manage.getAttribute("href")).toMatch(
		/\/o\/org-on-admin\/settings\/agents$/,
	);
	expect(screen.queryAllByRole("button")).toEqual([]);
});

it("shows On without a link for an organisation the user only belongs to", async () => {
	mockFetch([ORG_ON_MEMBER]);
	wrap();

	await screen.findByTestId("agent-org-org-on");
	expect(screen.getByTestId("agent-org-status-org-on").textContent).toBe("On");
	expect(screen.queryByTestId("agent-org-manage-org-on")).toBeNull();
	expect(screen.queryByTestId("agent-org-ask-org-on")).toBeNull();
});

it("shows Off with Turn on for a managed organisation, and the click enables it", async () => {
	const fetchMock = mockFetch([ORG_OFF_ADMIN, ORG_OFF_MEMBER]);
	wrap();

	await screen.findByTestId("agent-org-org-admin");
	expect(screen.getByTestId("agent-org-status-org-admin").textContent).toBe(
		"Off",
	);
	const button = screen.getByTestId("agent-org-enable-org-admin");
	expect(button.textContent).toBe("Turn on");
	expect(screen.queryByTestId("agent-org-enable-org-off")).toBeNull();

	fireEvent.click(button);
	await waitFor(() =>
		expect(
			fetchMock.mock.calls.filter(
				([input, init]) =>
					String(input).endsWith("/agent-access/organisations/org-admin") &&
					(init as RequestInit)?.method === "PATCH",
			),
		).toHaveLength(1),
	);
	const patch = fetchMock.mock.calls.find(
		([, init]) => (init as RequestInit)?.method === "PATCH",
	);
	expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ enabled: true });
});

it("shows Off with Ask your admin for an organisation the user cannot manage", async () => {
	mockFetch([ORG_OFF_MEMBER]);
	wrap();

	await screen.findByTestId("agent-org-org-off");
	expect(screen.getByTestId("agent-org-status-org-off").textContent).toBe(
		"Off",
	);
	expect(screen.getByTestId("agent-org-ask-org-off").textContent).toBe(
		"Ask your admin",
	);
	expect(screen.queryAllByRole("button")).toEqual([]);
});

it("says so when the user is in no organisation", async () => {
	mockFetch([]);
	wrap();

	const line = await screen.findByTestId("agent-org-empty");
	expect(line.textContent).toBe("You are not in an organisation yet.");
	expect(screen.queryAllByRole("button")).toEqual([]);
});
