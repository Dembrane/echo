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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectUsage } from "./ProjectUsageAndSharing";

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: { id: "w1" }, workspaceId: "w1" }),
}));

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const workspaceUsage = {
	projects: [{ conversation_hours: 2, id: "p1", name: "Strijp-S" }],
	tier: "free",
};
const conversationUsage = {
	active: [],
	active_hours: 0,
	deleted: [],
	deleted_hours: 0,
	total_hours: 0,
};

const json = (body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

const renderUsage = (fetchImpl: (url: string) => Promise<Response>) => {
	const fetchMock = vi.fn((input: RequestInfo | URL) =>
		fetchImpl(String(input)),
	);
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<ProjectUsage projectId="p1" />
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);
	return fetchMock;
};

const respond = (url: string) =>
	url.includes("/conversation-usage")
		? json(conversationUsage)
		: json(workspaceUsage);

const freshness = () =>
	screen.getByRole("button", { name: /Refresh/ }).parentElement?.textContent;

describe("ProjectUsage freshness line", () => {
	it("doesn't claim a time before the usage has loaded", () => {
		renderUsage(() => new Promise(() => {}));
		expect(freshness()).toBe("Updated  · Refresh");
	});

	it("says just now once both sources have loaded", async () => {
		renderUsage(respond);
		await waitFor(() => expect(freshness()).toContain("just now"));
	});

	it("refetches both sources on Refresh", async () => {
		const fetchMock = renderUsage(respond);
		await waitFor(() => expect(freshness()).toContain("just now"));
		const before = fetchMock.mock.calls.length;

		fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

		await waitFor(() =>
			expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(before + 2),
		);
		const urls = fetchMock.mock.calls.slice(before).map(([u]) => String(u));
		expect(urls.some((u) => u.endsWith("/v2/workspaces/w1/usage"))).toBe(true);
		expect(
			urls.some((u) => u.endsWith("/v2/projects/p1/conversation-usage")),
		).toBe(true);
	});
});
