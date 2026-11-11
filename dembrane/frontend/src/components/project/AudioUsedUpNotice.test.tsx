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

const allowance = (exhausted: boolean, percent = exhausted ? 100 : 40) => ({
	ai: { exhausted, percent_used: percent, unlimited: false },
	audio_seconds: { limit: 18_000, used: 0 },
	free: true,
	period_start: "2026-11-01T00:00:00Z",
	projects: null,
	resets_at: "2026-12-01T00:00:00Z",
});

const respond = (
	recording: unknown,
	isSample = false,
	free: unknown = allowance(false),
) =>
	fetchMock.mockImplementation(async (url: string) =>
		String(url).includes("/recording")
			? answer(200, recording)
			: String(url).includes("/free-allowance")
				? answer(200, free)
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
const allowanceReads = () =>
	fetchMock.mock.calls.filter(([url]) =>
		String(url).includes("/free-allowance"),
	).length;

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

it("renders nothing on a paid account, and reads no allowance", async () => {
	respond(UNLIMITED);
	const client = renderNotice();
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
	expect(projectReads()).toBe(0);
	expect(allowanceReads()).toBe(0);
});

it("renders the AI banner when this month's AI is used up", async () => {
	respond(status(3600), false, allowance(true));
	renderNotice();
	const banner = await screen.findByTestId("free-allowance-banner");
	expect(banner.dataset.feature).toBe("ai");
	expect(banner.dataset.workspace).toBe("ws-1");
});

it("renders nothing for AI that is not used up yet", async () => {
	respond(status(3600), false, allowance(false, 90));
	const client = renderNotice();
	await settled(client);
	await waitFor(() => expect(allowanceReads()).toBe(1));
	await new Promise((r) => setTimeout(r, 20));
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders both banners when audio and AI are both used up", async () => {
	respond(status(0), false, allowance(true));
	renderNotice();
	await waitFor(() =>
		expect(
			screen
				.getAllByTestId("free-allowance-banner")
				.map((b) => b.dataset.feature),
		).toEqual(["ai", "audio"]),
	);
});

it("renders nothing for used-up AI on a sample project", async () => {
	respond(status(3600), true, allowance(true));
	const client = renderNotice();
	await settled(client);
	await waitFor(() => expect(projectReads()).toBe(1));
	await new Promise((r) => setTimeout(r, 20));
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders nothing on a sample project", async () => {
	respond(status(0), true);
	const client = renderNotice();
	await settled(client);
	await waitFor(() => expect(projectReads()).toBe(1));
	await new Promise((r) => setTimeout(r, 20));
	expect(screen.getByTestId("host").innerHTML).toBe("");
});
