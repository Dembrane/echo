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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	AgentConsentRoute,
	canAllow,
	grantedScopes,
} from "./AgentConsentRoute";

vi.mock("posthog-js", () => ({
	default: { capture: () => {} },
}));

const ORG_ON = {
	agent_access_enabled: true,
	calls_this_month: 3,
	can_manage: true,
	id: "org-on",
	is_paid: false,
	monthly_limit: 1000,
	name: "Facilitation BV",
	role: "owner",
	updated_at: null,
};

const ORG_OFF = {
	...ORG_ON,
	agent_access_enabled: false,
	can_manage: false,
	id: "org-off",
	name: "Other BV",
	role: "member",
};

const authorizeRequest = (organisations: (typeof ORG_ON)[]) => ({
	client_id: "client-1",
	client_name: "Test agent",
	consent_version: "2026-09-06",
	expiry_choices_days: [30, 90, 365],
	organisations,
	redirect_host: "localhost:9999",
	request_id: "req-1",
	requested_scopes: ["read", "write"],
});

const mockFetch = (organisations: (typeof ORG_ON)[]) => {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/authorize-requests/req-1/approve")) {
				return new Response(JSON.stringify({ redirect_url: "about:blank" }), {
					headers: { "Content-Type": "application/json" },
					status: 200,
				});
			}
			if (url.includes("/authorize-requests/req-1")) {
				return new Response(JSON.stringify(authorizeRequest(organisations)), {
					headers: { "Content-Type": "application/json" },
					status: 200,
				});
			}
			return new Response("{}", { status: 404 });
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
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

beforeEach(() => {
	vi.restoreAllMocks();
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
					<MemoryRouter
						initialEntries={["/settings/agents/authorize?request=req-1"]}
					>
						<AgentConsentRoute />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

const allowButton = () =>
	screen.getByTestId("agent-consent-allow") as HTMLButtonElement;

it("keeps Allow off until the risk checkbox and one organisation are both set", async () => {
	mockFetch([ORG_ON, ORG_OFF]);
	wrap();

	await screen.findByTestId("agent-consent-title");
	expect(screen.getByTestId("agent-consent-title").textContent).toContain(
		"Test agent wants MCP access to dembrane",
	);

	// The single enabled org is preselected, but consent is not: Allow stays off.
	const orgOn = screen.getByTestId("consent-org-checkbox-org-on");
	await waitFor(() => expect((orgOn as HTMLInputElement).checked).toBe(true));
	expect(allowButton().disabled).toBe(true);

	// A disabled org cannot be picked, and says why.
	const orgOff = screen.getByTestId("consent-org-checkbox-org-off");
	expect((orgOff as HTMLInputElement).disabled).toBe(true);
	expect(screen.getByTestId("consent-org-org-off").textContent).toContain(
		"Not enabled by an admin",
	);

	// Consent alone turns Allow on.
	fireEvent.click(screen.getByTestId("agent-consent-accept"));
	await waitFor(() => expect(allowButton().disabled).toBe(false));

	// Dropping the last org turns it off again, consent or not.
	fireEvent.click(orgOn);
	await waitFor(() => expect(allowButton().disabled).toBe(true));

	fireEvent.click(orgOn);
	await waitFor(() => expect(allowButton().disabled).toBe(false));
});

it("preselects nothing when more than one organisation is enabled", async () => {
	mockFetch([ORG_ON, { ...ORG_ON, id: "org-two", name: "Second BV" }]);
	wrap();

	await screen.findByTestId("agent-consent-title");
	fireEvent.click(screen.getByTestId("agent-consent-accept"));

	// Two real choices: the user must make one before Allow lights up.
	expect(allowButton().disabled).toBe(true);
	fireEvent.click(screen.getByTestId("consent-org-checkbox-org-two"));
	await waitFor(() => expect(allowButton().disabled).toBe(false));
});

it("tells the user to start again when the request is gone", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response('{"detail":"expired"}', { status: 404 })),
	);
	wrap();

	await screen.findByText("This request has expired");
	expect(screen.getByTestId("agent-consent-card").textContent).toContain(
		"Start again from your agent",
	);
	expect(screen.queryByTestId("agent-consent-allow")).toBeNull();
});

it("grants read only unless the write box is ticked", async () => {
	const fetchMock = mockFetch([ORG_ON]);
	const assign = vi.fn();
	vi.spyOn(window, "location", "get").mockReturnValue({
		...window.location,
		assign,
	} as unknown as Location);
	wrap();

	await screen.findByTestId("agent-consent-title");
	const write = screen.getByTestId("agent-consent-write") as HTMLInputElement;
	expect(write.checked).toBe(false);

	fireEvent.click(screen.getByTestId("agent-consent-accept"));
	await waitFor(() => expect(allowButton().disabled).toBe(false));
	fireEvent.click(allowButton());

	await waitFor(() => expect(assign).toHaveBeenCalled());
	const approveCall = fetchMock.mock.calls.find(([input]) =>
		String(input).includes("/approve"),
	);
	const body = JSON.parse(String((approveCall?.[1] as RequestInit).body));
	expect(body.scopes).toEqual(["read"]);
});

it("grantedScopes adds write only when requested and ticked", () => {
	expect(
		grantedScopes({ allowWrite: false, requestedScopes: ["read", "write"] }),
	).toEqual(["read"]);
	expect(
		grantedScopes({ allowWrite: true, requestedScopes: ["read", "write"] }),
	).toEqual(["read", "write"]);
	expect(
		grantedScopes({ allowWrite: true, requestedScopes: ["read"] }),
	).toEqual(["read"]);
});

it("canAllow needs both consent and an organisation", () => {
	expect(canAllow({ consentAccepted: false, selectedOrgIds: [] })).toBe(false);
	expect(canAllow({ consentAccepted: true, selectedOrgIds: [] })).toBe(false);
	expect(canAllow({ consentAccepted: false, selectedOrgIds: ["a"] })).toBe(
		false,
	);
	expect(canAllow({ consentAccepted: true, selectedOrgIds: ["a"] })).toBe(true);
});
