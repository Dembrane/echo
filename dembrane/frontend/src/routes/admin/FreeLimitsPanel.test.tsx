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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FreeLimitsPanel } from "./FreeLimitsPanel";

const fetchMock = vi.fn();

const DEFAULTS: Record<string, number> = {
	audio_seconds_conversation: 3600,
	audio_seconds_month: 18000,
	chat_turns_first: 20,
	chat_turns_second: 3,
	chats_month: 2,
	maps_month: 1,
	popcorn_cadence_minutes: 5,
	popcorn_sessions_month: 1,
	popcorn_window_minutes: 60,
	projects: 1,
	reports_month: 1,
};

const limitsBody = (overrides: Record<string, number> = {}) => ({
	limits: Object.entries(DEFAULTS).map(([key, def]) => ({
		default: def,
		key,
		updated_at: key in overrides ? "2026-10-20T10:00:00.000Z" : null,
		updated_by:
			key in overrides ? "11111111-2222-3333-4444-555555555555" : null,
		value: overrides[key] ?? def,
	})),
});

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
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

const renderPanel = () => {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<FreeLimitsPanel />
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
};

const row = (key: string) => screen.getByTestId(`free-limit-row-${key}`);

it("renders one row per limit", async () => {
	fetchMock.mockResolvedValue(answer(200, limitsBody()));
	renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_month");
	expect(screen.getAllByTestId(/^free-limit-row-/)).toHaveLength(11);
});

it("shows audio seconds as hours", async () => {
	fetchMock.mockResolvedValue(answer(200, limitsBody()));
	renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_month");
	const r = row("audio_seconds_month");
	expect(within(r).getByTestId("free-limit-current").textContent).toBe("5 h");
	expect(within(r).getByRole("textbox")).toHaveProperty("value", "5");
});

it("saving 6 hours sends 21600 seconds", async () => {
	let saved: Record<string, number> = {};
	fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "PUT") saved = { audio_seconds_month: 21600 };
		return answer(200, limitsBody(saved));
	});
	renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_month");
	const r = row("audio_seconds_month");
	fireEvent.change(within(r).getByRole("textbox"), { target: { value: "6" } });
	fireEvent.click(within(r).getByRole("button", { name: "Save" }));

	await waitFor(() => {
		const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
		expect(put).toBeDefined();
	});
	const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
	expect(String(put?.[0])).toMatch(
		/\/v2\/admin\/free-limits\/audio_seconds_month$/,
	);
	expect(JSON.parse(String(put?.[1]?.body))).toEqual({ value: 21600 });
	await waitFor(() =>
		expect(
			within(row("audio_seconds_month")).getByTestId("free-limit-current")
				.textContent,
		).toBe("6 h"),
	);
});

it("a server 400 shows the error notice and keeps the old value", async () => {
	fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "PUT"
			? answer(400, { code: "request.invalid", detail: "Bad Request" })
			: answer(200, limitsBody()),
	);
	const { container } = renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_month");
	const r = row("audio_seconds_month");
	fireEvent.change(within(r).getByRole("textbox"), { target: { value: "6" } });
	fireEvent.click(within(r).getByRole("button", { name: "Save" }));

	await waitFor(() =>
		expect(
			container.querySelector('[data-error-code="request.invalid"]'),
		).not.toBeNull(),
	);
	expect(
		within(row("audio_seconds_month")).getByTestId("free-limit-current")
			.textContent,
	).toBe("5 h");
});

it("formats the changed-at time in the app language, not the browser's", async () => {
	i18n.load("nl-NL", {});
	i18n.activate("nl-NL");
	try {
		fetchMock.mockResolvedValue(answer(200, limitsBody({ projects: 2 })));
		renderPanel();
		await screen.findByTestId("free-limit-row-projects");
		const nl = new Date("2026-10-20T10:00:00.000Z").toLocaleString("nl-NL", {
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			month: "short",
			year: "numeric",
		});
		expect(row("projects").textContent).toContain(nl);
	} finally {
		i18n.activate("en");
	}
});
