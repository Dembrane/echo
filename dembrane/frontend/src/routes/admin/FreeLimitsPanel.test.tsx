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
	chat_turns_per_chat: 20,
	chats_month: 2,
	maps_month: 1,
	popcorn_analyses_month: 12,
	popcorn_cadence_minutes: 5,
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
		updated_by_name: key in overrides ? "Sam Staff (sam@dembrane.com)" : null,
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
	expect(screen.getAllByTestId(/^free-limit-row-/)).toHaveLength(9);
});

it("labels the chat turn and popcorn rows", async () => {
	fetchMock.mockResolvedValue(answer(200, limitsBody()));
	renderPanel();
	await screen.findByTestId("free-limit-row-chat_turns_per_chat");
	const current = (key: string) =>
		within(row(key)).getByTestId("free-limit-current").textContent;
	expect(
		within(row("chat_turns_per_chat")).getByText("Turns per chat"),
	).toBeTruthy();
	expect(current("chat_turns_per_chat")).toBe("20");
	expect(
		within(row("popcorn_analyses_month")).getByText(
			"Popcorn analyses per month",
		),
	).toBeTruthy();
	expect(current("popcorn_analyses_month")).toBe("12");
	expect(screen.queryByText("Popcorn window")).toBeNull();
});

it("shows audio as hours and minutes and edits it in minutes", async () => {
	fetchMock.mockResolvedValue(
		answer(200, limitsBody({ audio_seconds_conversation: 5400 })),
	);
	renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_month");
	const r = row("audio_seconds_month");
	expect(within(r).getByTestId("free-limit-current").textContent).toBe("5 h");
	expect(within(r).getByRole("textbox")).toHaveProperty("value", "300");
	const c = row("audio_seconds_conversation");
	expect(within(c).getByTestId("free-limit-current").textContent).toBe(
		"1 h 30 min",
	);
	expect(within(c).getByRole("textbox")).toHaveProperty("value", "90");
});

const putBody = async () => {
	await waitFor(() => {
		const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
		expect(put).toBeDefined();
	});
	const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
	return { body: JSON.parse(String(put?.[1]?.body)), url: String(put?.[0]) };
};

it("saving 360 minutes sends 21600 seconds", async () => {
	let saved: Record<string, number> = {};
	fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "PUT") saved = { audio_seconds_month: 21600 };
		return answer(200, limitsBody(saved));
	});
	renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_month");
	const r = row("audio_seconds_month");
	fireEvent.change(within(r).getByRole("textbox"), {
		target: { value: "360" },
	});
	fireEvent.click(within(r).getByRole("button", { name: "Save" }));

	const put = await putBody();
	expect(put.url).toMatch(/\/v2\/admin\/free-limits\/audio_seconds_month$/);
	expect(put.body).toEqual({ value: 21600 });
	await waitFor(() =>
		expect(
			within(row("audio_seconds_month")).getByTestId("free-limit-current")
				.textContent,
		).toBe("6 h"),
	);
});

it("sets an audio limit of one minute", async () => {
	fetchMock.mockResolvedValue(answer(200, limitsBody()));
	renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_conversation");
	const r = row("audio_seconds_conversation");
	fireEvent.change(within(r).getByRole("textbox"), { target: { value: "1" } });
	fireEvent.click(within(r).getByRole("button", { name: "Save" }));
	expect((await putBody()).body).toEqual({ value: 60 });
});

it("never rewrites an unedited value that is not a whole number of minutes", async () => {
	fetchMock.mockResolvedValue(
		answer(200, limitsBody({ audio_seconds_conversation: 50 })),
	);
	renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_conversation");
	const r = row("audio_seconds_conversation");
	expect(within(r).getByTestId("free-limit-current").textContent).toBe(
		"0.83 min",
	);
	expect(within(r).getByRole("button", { name: "Save" })).toHaveProperty(
		"disabled",
		true,
	);
});

it("allows saving up to the largest value the input accepts, and no more", async () => {
	fetchMock.mockResolvedValue(answer(200, limitsBody()));
	renderPanel();
	await screen.findByTestId("free-limit-row-audio_seconds_month");
	const r = row("audio_seconds_month");
	const input = within(r).getByRole("textbox");
	const save = within(r).getByRole("button", { name: "Save" });
	fireEvent.change(input, { target: { value: "166666.66" } });
	expect(save).toHaveProperty("disabled", false);
	fireEvent.change(input, { target: { value: "166667" } });
	expect(save).toHaveProperty("disabled", true);
});

it("names the staff user who changed a limit", async () => {
	fetchMock.mockResolvedValue(answer(200, limitsBody({ projects: 2 })));
	renderPanel();
	await screen.findByTestId("free-limit-row-projects");
	expect(row("projects").textContent).toContain("Sam Staff (sam@dembrane.com)");
	expect(row("projects").textContent).not.toContain("11111111-2222");
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
