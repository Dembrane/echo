// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("@/hooks/useWorkspace", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useWorkspace")>()),
	useWorkspace: () => ({ setWorkspace: () => {} }),
}));

const { JoinSupportControl } = await import("./JoinSupportControl");

// What dembrane answers about the caller's visit and request to workspace w1.
let answer: {
	visit: { active: boolean; expires_at: string | null; can_change: boolean };
	request: {
		support_access_enabled: boolean;
		request: { id: string; status: string; created_at: string } | null;
	};
};

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
	});

const renderControl = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={["/en-US/admin"]}>
						<JoinSupportControl workspaceId="w1" workspaceName="Research" />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const button = (name: string) => screen.queryByRole("button", { name });
const inADay = new Date(Date.now() + 20 * 3_600_000).toISOString();

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockImplementation((media: string) => ({
			addEventListener: vi.fn(),
			addListener: vi.fn(),
			dispatchEvent: vi.fn(),
			matches: false,
			media,
			onchange: null,
			removeEventListener: vi.fn(),
			removeListener: vi.fn(),
		})),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/join-support")) return json(answer.visit);
			if (url.endsWith("/support-access/request")) return json(answer.request);
			return json({});
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("joining for support in Usage and billing", () => {
	it("offers to join and to ask for more while the customer's switch is on", async () => {
		answer = {
			request: { request: null, support_access_enabled: true },
			visit: { active: false, can_change: false, expires_at: null },
		};
		renderControl();
		await waitFor(() => expect(button("Request access")).toBeTruthy());
		expect(button("Join for support (24h)")).toBeTruthy();
	});

	it("on a read-only visit, still offers to ask to make changes", async () => {
		answer = {
			request: { request: null, support_access_enabled: true },
			visit: { active: true, can_change: false, expires_at: inADay },
		};
		renderControl();
		await waitFor(() => expect(button("Request access")).toBeTruthy());
		expect(button("Extend 24h")).toBeTruthy();
		expect(button("Leave now")).toBeTruthy();
	});

	it("on a visit that can make changes, has nothing left to ask", async () => {
		answer = {
			request: { request: null, support_access_enabled: true },
			visit: { active: true, can_change: true, expires_at: inADay },
		};
		renderControl();
		await waitFor(() => expect(button("Leave now")).toBeTruthy());
		expect(button("Request access")).toBeNull();
	});

	it("with the switch off and nothing asked, offers only to ask", async () => {
		answer = {
			request: { request: null, support_access_enabled: false },
			visit: { active: false, can_change: false, expires_at: null },
		};
		renderControl();
		await waitFor(() => expect(button("Request access")).toBeTruthy());
		expect(button("Join for support (24h)")).toBeNull();
	});
});
