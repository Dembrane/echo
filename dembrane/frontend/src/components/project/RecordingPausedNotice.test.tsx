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
	RecordingPausedNotice,
	RecordingPausedUploadButton,
} from "./RecordingPausedNotice";

const fetchMock = vi.fn();

vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		opened,
		wallKey,
		currentTier,
	}: {
		opened: boolean;
		wallKey: string;
		currentTier: string;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-tier={currentTier}
			/>
		) : null,
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

const status = (overrides: Record<string, unknown> = {}) => ({
	audio_seconds_left: 7200,
	can_switch: true,
	file_limit_seconds: 3600,
	free: true,
	is_recording_project: false,
	recording_project: { id: "p-rec", name: "Town hall", workspace_id: "ws-1" },
	...overrides,
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
	const view = render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter>
						<div data-testid="host">
							<RecordingPausedNotice projectId="p-2" workspaceId="ws-1" />
						</div>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	return { client, view };
};

const settled = (client: QueryClient) =>
	waitFor(() =>
		expect(client.getQueryState(["project", "p-2", "recording"])?.status).toBe(
			"success",
		),
	);

it("fetches the project's recording status", async () => {
	fetchMock.mockResolvedValue(answer(200, UNLIMITED));
	const { client } = renderNotice();
	await settled(client);
	expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
		/\/v2\/projects\/p-2\/recording$/,
	);
});

it("renders nothing for a paid account", async () => {
	fetchMock.mockResolvedValue(answer(200, UNLIMITED));
	const { client } = renderNotice();
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders nothing on the recording project", async () => {
	fetchMock.mockResolvedValue(
		answer(200, status({ is_recording_project: true })),
	);
	const { client } = renderNotice();
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("names the recording project on another project", async () => {
	fetchMock.mockResolvedValue(answer(200, status()));
	renderNotice();
	expect(
		await screen.findByText(
			"Recordings are paused for this project on the free plan. New recordings go to Town hall.",
		),
	).toBeTruthy();
	expect(
		screen.getByRole("button", { name: "Use this project for recordings" }),
	).toBeTruthy();
});

it("says another project when the recording project has no name", async () => {
	fetchMock.mockResolvedValue(
		answer(
			200,
			status({
				recording_project: { id: "p-rec", name: "", workspace_id: "ws-1" },
			}),
		),
	);
	renderNotice();
	expect(
		await screen.findByText(
			"Recordings are paused for this project on the free plan. New recordings go to another project.",
		),
	).toBeTruthy();
});

it("hides the switch when the caller cannot switch", async () => {
	fetchMock.mockResolvedValue(answer(200, status({ can_switch: false })));
	renderNotice();
	await screen.findByTestId("recording-paused-notice");
	expect(
		screen.queryByRole("button", { name: "Use this project for recordings" }),
	).toBeNull();
});

it("switches the project and disappears once it is the recording project", async () => {
	let switched = false;
	fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			switched = true;
			return answer(200, status({ is_recording_project: true }));
		}
		return answer(200, status({ is_recording_project: switched }));
	});
	renderNotice();
	fireEvent.click(
		await screen.findByRole("button", {
			name: "Use this project for recordings",
		}),
	);
	await waitFor(() =>
		expect(screen.queryByTestId("recording-paused-notice")).toBeNull(),
	);
	const post = fetchMock.mock.calls.find(
		([, init]) => (init as RequestInit | undefined)?.method === "POST",
	);
	expect(String(post?.[0])).toMatch(/\/v2\/projects\/p-2\/recording$/);
});

it("invalidates recording and free allowance queries on switch", async () => {
	fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? answer(200, status({ is_recording_project: true }))
			: answer(200, status()),
	);
	const { client } = renderNotice();
	client.setQueryData(["project", "p-rec", "recording"], status());
	client.setQueryData(["workspace", "ws-1", "free-allowance"], { free: true });
	fireEvent.click(
		await screen.findByRole("button", {
			name: "Use this project for recordings",
		}),
	);
	await waitFor(() => {
		expect(
			client.getQueryState(["project", "p-rec", "recording"])?.isInvalidated,
		).toBe(true);
		expect(
			client.getQueryState(["workspace", "ws-1", "free-allowance"])
				?.isInvalidated,
		).toBe(true);
	});
});

it("opens the upgrade modal on the recording project wall", async () => {
	fetchMock.mockResolvedValue(answer(200, status()));
	renderNotice();
	fireEvent.click(await screen.findByTestId("recording-paused-notice-upgrade"));
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.getAttribute("data-wall")).toBe("recording_project");
	expect(modal.getAttribute("data-tier")).toBe("free");
});

it("never shows an em dash", async () => {
	fetchMock.mockResolvedValue(answer(200, status()));
	renderNotice();
	await screen.findByTestId("recording-paused-notice");
	expect(screen.getByTestId("host").textContent).not.toContain("—");
});

it("renders the upload button disabled with where uploads go", async () => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<RecordingPausedUploadButton name="Town hall" />
			</MantineProvider>
		</I18nProvider>,
	);
	const button = screen.getByTestId("recording-paused-upload-button");
	expect(button.getAttribute("aria-disabled")).toBe("true");
	fireEvent.mouseEnter(button);
	expect(
		await screen.findByText("On the free plan, uploads go to Town hall."),
	).toBeTruthy();
});

it("says another project on the upload button when the name is empty", async () => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<RecordingPausedUploadButton name="  " />
			</MantineProvider>
		</I18nProvider>,
	);
	fireEvent.mouseEnter(screen.getByTestId("recording-paused-upload-button"));
	expect(
		await screen.findByText("On the free plan, uploads go to another project."),
	).toBeTruthy();
});
