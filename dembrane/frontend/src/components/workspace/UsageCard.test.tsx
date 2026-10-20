// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { UsageCard } from "./UsageCard";

const fetchMock = vi.fn();

const usage = (overrides: Record<string, unknown> = {}) => ({
	audio_hours: 0.75,
	audio_hours_included: 1,
	cycle_end_exclusive: "2026-11-01T00:00:00Z",
	cycle_start: "2026-10-01T00:00:00Z",
	external_count: 0,
	member_count: 2,
	next_tier: null,
	observer_count: 0,
	pending_count: 0,
	pilot_hard_block_active: true,
	project_count: 1,
	projects: [],
	seat_count: 2,
	seat_count_included: 5,
	tier: "free",
	tier_tagline: "",
	usage_gates: {
		over_cap_active: true,
		upgrade_cta_tier: "changemaker",
		uploads_locked: true,
	},
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

const renderCard = (body: unknown) => {
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify(body), {
			headers: { "Content-Type": "application/json" },
			status: 200,
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<UsageCard workspaceId="ws-1" />
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
};

const audioRow = () => {
	const label = screen.getByText("Audio");
	return label.closest(".mantine-Stack-root") as HTMLElement;
};

it("shows no legacy hours cap for a free workspace", async () => {
	renderCard(usage());
	await screen.findByText("Audio");
	expect(audioRow().textContent).toBe("Audio45 min");
	expect(audioRow().querySelector('[role="progressbar"]')).toBeNull();
	expect(screen.queryByText("Included hours used up")).toBeNull();
	expect(screen.queryByText(/upload/i)).toBeNull();
	// Other content stays.
	expect(screen.getByText("Seats")).toBeTruthy();
	expect(screen.getByText("Projects")).toBeTruthy();
});

it("keeps the hours cap for a paid workspace", async () => {
	renderCard(usage({ audio_hours_included: 10, tier: "changemaker" }));
	await screen.findByText("Audio");
	expect(audioRow().textContent).toBe("Audio45 min / 10h");
	expect(audioRow().querySelector('[role="progressbar"]')).not.toBeNull();
	expect(screen.getByText("Included hours used up")).toBeTruthy();
});
