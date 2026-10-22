// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AudioUsedUpNotice } from "./AudioUsedUpNotice";

const fetchMock = vi.fn();

vi.mock("@/components/workspace/FreeAllowanceBanner", () => ({
	FreeAllowanceBanner: ({
		feature,
		workspaceId,
	}: {
		feature: string;
		workspaceId: string;
	}) => (
		<div
			data-testid="free-allowance-banner"
			data-feature={feature}
			data-workspace={workspaceId}
		/>
	),
}));

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

const UNLIMITED = {
	audio_seconds_left: null,
	can_switch: false,
	file_limit_seconds: null,
	free: false,
	is_recording_project: true,
	recording_project: null,
};

const status = (left: number) => ({
	audio_seconds_left: left,
	can_switch: false,
	file_limit_seconds: 3600,
	free: true,
	is_recording_project: true,
	recording_project: { id: "p-1", name: "Town hall", workspace_id: "ws-1" },
});

const respond = (recording: unknown, isSample = false) =>
	fetchMock.mockImplementation(async (url: string) =>
		String(url).includes("/recording")
			? answer(200, recording)
			: answer(200, { id: "p-1", is_sample: isSample }),
	);

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
	vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
	fetchMock.mockReset();
});

afterEach(() => {
	cleanup();
});

const renderNotice = () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter>
						<div data-testid="host">
							<AudioUsedUpNotice projectId="p-1" workspaceId="ws-1" />
						</div>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	return client;
};

const settled = (client: QueryClient) =>
	waitFor(() =>
		expect(client.getQueryState(["project", "p-1", "recording"])?.status).toBe(
			"success",
		),
	);

const projectReads = () =>
	fetchMock.mock.calls.filter(([url]) => String(url).includes("/bff")).length;

it("renders the audio banner when the free month's audio is used up", async () => {
	respond(status(30));
	renderNotice();
	const banner = await screen.findByTestId("free-allowance-banner");
	expect(banner.dataset.feature).toBe("audio");
	expect(banner.dataset.workspace).toBe("ws-1");
});

it("renders nothing with audio left", async () => {
	respond(status(3600));
	const client = renderNotice();
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
	expect(projectReads()).toBe(0);
});

it("renders nothing on a paid account", async () => {
	respond(UNLIMITED);
	const client = renderNotice();
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
	expect(projectReads()).toBe(0);
});

it("renders nothing on a sample project", async () => {
	respond(status(0), true);
	const client = renderNotice();
	await settled(client);
	await waitFor(() => expect(projectReads()).toBe(1));
	await new Promise((r) => setTimeout(r, 20));
	expect(screen.getByTestId("host").innerHTML).toBe("");
});
