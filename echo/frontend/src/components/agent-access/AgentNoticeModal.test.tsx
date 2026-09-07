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
import { AgentNoticeModal } from "./AgentAccessSection";

vi.mock("posthog-js", () => ({
	default: { capture: () => {} },
}));

const navigate = vi.fn();
vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => navigate,
}));

const me = (accepted: boolean) => ({
	avatar: null,
	directus_user_id: "du-1",
	display_name: "Someone",
	email: "someone@example.com",
	has_legacy_projects: false,
	has_pending_invites: false,
	id: "u-1",
	is_staff: false,
	onboarding_answer_json: null,
	onboarding_completed: true,
	orgs: [],
	settings: accepted
		? { agent_notice_accepted_at: "2026-09-01T00:00:00Z" }
		: {},
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

const mockFetch = ({ accepted = false }: { accepted?: boolean } = {}) => {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.endsWith("/v2/me") && method === "GET") return json(me(accepted));
			if (url.endsWith("/v2/me") && method === "PATCH") return json({});
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
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

beforeEach(() => {
	navigate.mockClear();
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
						<AgentNoticeModal />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

const patchCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
	fetchMock.mock.calls.filter(
		([input, init]) =>
			String(input).endsWith("/v2/me") &&
			(init as RequestInit)?.method === "PATCH",
	);

it("shows the notice when the flag is absent", async () => {
	mockFetch();
	wrap();

	const modal = await screen.findByTestId("agent-notice-modal");
	expect(modal.textContent).toContain("Your data will leave dembrane");
	expect(modal.textContent).toContain("dembrane is not responsible");
	expect(screen.getByTestId("agent-notice-back")).toBeTruthy();
	expect(screen.getByTestId("agent-notice-accept")).toBeTruthy();
});

it("shows nothing once the flag is set", async () => {
	const fetchMock = mockFetch({ accepted: true });
	wrap();

	await waitFor(() =>
		expect(
			fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v2/me")),
		).toBe(true),
	);
	expect(screen.queryByTestId("agent-notice-modal")).toBeNull();
});

it("records acceptance on I understand", async () => {
	const fetchMock = mockFetch();
	wrap();

	await screen.findByTestId("agent-notice-modal");
	fireEvent.click(screen.getByTestId("agent-notice-accept"));

	await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
	const body = JSON.parse(String(patchCalls(fetchMock)[0][1]?.body));
	expect(body.settings.agent_notice_accepted_at).toBeTruthy();
	expect(navigate).not.toHaveBeenCalled();
});

it("goes back without writing anything", async () => {
	const fetchMock = mockFetch();
	wrap();

	await screen.findByTestId("agent-notice-modal");
	fireEvent.click(screen.getByTestId("agent-notice-back"));
	expect(navigate).toHaveBeenCalledWith("/o");
	expect(patchCalls(fetchMock)).toEqual([]);
});

it("treats Escape and the X as going back", async () => {
	const fetchMock = mockFetch();
	wrap();
	await screen.findByTestId("agent-notice-modal");

	fireEvent.keyDown(document.activeElement ?? document.body, {
		key: "Escape",
	});
	await waitFor(() => expect(navigate).toHaveBeenCalledWith("/o"));

	navigate.mockClear();
	fireEvent.click(screen.getByLabelText("Close"));
	expect(navigate).toHaveBeenCalledWith("/o");

	expect(patchCalls(fetchMock)).toEqual([]);
});
