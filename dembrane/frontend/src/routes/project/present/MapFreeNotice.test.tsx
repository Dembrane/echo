// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { MapFreeNotice, presentsMap } from "./MapFreeNotice";

const state: {
	allowance: Record<string, unknown> | undefined;
	sample: { isSuccess: boolean; data?: { is_sample?: boolean | null } };
	allowanceFor: (string | null | undefined)[];
} = {
	allowance: undefined,
	allowanceFor: [],
	sample: { isSuccess: false },
};

vi.mock("@/hooks/useFreeAllowance", () => ({
	useFreeAllowance: (workspaceId: string | null | undefined) => {
		state.allowanceFor.push(workspaceId);
		return { data: workspaceId ? state.allowance : undefined };
	},
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => state.sample,
}));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		aiAction,
		opened,
		resetsAt,
		wallKey,
		currentTier,
	}: {
		aiAction?: string;
		opened: boolean;
		resetsAt?: string | null;
		wallKey: string;
		currentTier: string;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-tier={currentTier}
				data-action={aiAction}
				data-resets={resetsAt ?? ""}
			/>
		) : null,
}));

const spent = {
	ai: { exhausted: true, percent_used: 100, unlimited: false },
	free: true,
	resets_at: "2026-11-01T00:00:00Z",
};

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
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
});

afterEach(() => {
	cleanup();
	state.allowance = undefined;
	state.allowanceFor = [];
	state.sample = { isSuccess: false };
});

const renderNotice = (mapOn = true) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter>
						<MapFreeNotice mapOn={mapOn} workspaceId="w1" projectId="p1" />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

it("tells the host the map can't update and opens the AI wall", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = spent;
	renderNotice();
	const text = screen.getByTestId("map-free-notice").textContent ?? "";
	expect(text).toContain(
		"This month's AI is used up, so the map can't update until 1 November 2026.",
	);
	fireEvent.click(screen.getByRole("button", { name: "See upgrade options" }));
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	expect(modal.dataset.action).toBe("map");
	expect(modal.dataset.resets).toBe("2026-11-01T00:00:00Z");
	expect(modal.dataset.tier).toBe("free");
});

it("says next month when the reset is unknown", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = { ...spent, resets_at: null };
	renderNotice();
	const text = screen.getByTestId("map-free-notice").textContent ?? "";
	expect(text).toContain(
		"This month's AI is used up, so the map can't update until next month.",
	);
});

it("stays quiet while the AI has room, the map is off, or the project is a sample", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = {
		...spent,
		ai: { exhausted: false, percent_used: 95, unlimited: false },
	};
	renderNotice();
	expect(screen.queryByTestId("map-free-notice")).toBeNull();
	cleanup();

	state.allowance = spent;
	renderNotice(false);
	expect(screen.queryByTestId("map-free-notice")).toBeNull();
	expect(state.allowanceFor.at(-1)).toBeFalsy();
	cleanup();

	state.sample = { data: { is_sample: true }, isSuccess: true };
	renderNotice();
	expect(screen.queryByTestId("map-free-notice")).toBeNull();
	cleanup();

	state.sample = { isSuccess: false };
	renderNotice();
	expect(screen.queryByTestId("map-free-notice")).toBeNull();
});

it("stays quiet on a paid or unlimited account", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = { ...spent, ai: null, free: false };
	renderNotice();
	expect(screen.queryByTestId("map-free-notice")).toBeNull();
	cleanup();

	state.allowance = {
		...spent,
		ai: { exhausted: false, percent_used: 0, unlimited: true },
	};
	renderNotice();
	expect(screen.queryByTestId("map-free-notice")).toBeNull();
});

it("counts the map as on only when the published or draft blocks hold it", () => {
	const settings = (blocks?: string[]) =>
		blocks ? { presentation: { blocks } } : {};
	expect(presentsMap(settings(["popcorn"]), settings(["popcorn"]))).toBe(false);
	expect(presentsMap(settings(), undefined)).toBe(false);
	expect(presentsMap(undefined, undefined)).toBe(false);
	expect(presentsMap(settings(["popcorn", "map"]), undefined)).toBe(true);
	expect(presentsMap(settings(["popcorn"]), settings(["map"]))).toBe(true);
});
