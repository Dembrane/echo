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

const spent = {
	free: true,
	maps: { limit: 1, used: 1 },
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

it("tells the host the map keeps its version and opens the map wall", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = spent;
	renderNotice();
	const text = screen.getByTestId("map-free-notice").textContent ?? "";
	expect(text).toContain(
		"You have used this month's free map. The map in this presentation keeps its current version until ",
	);
	expect(text).toContain("2026");
	fireEvent.click(screen.getByRole("button", { name: "See upgrade options" }));
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("map_cap");
	expect(modal.dataset.tier).toBe("free");
});

it("ends without a date when the reset is unknown", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = { ...spent, resets_at: null };
	renderNotice();
	const text = screen.getByTestId("map-free-notice").textContent ?? "";
	expect(text).toContain(
		"You have used this month's free map. The map in this presentation keeps its current version.",
	);
	expect(text).not.toContain("until");
});

it("stays quiet while the map is left, the map is off, or the project is a sample", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = { ...spent, maps: { limit: 1, used: 0 } };
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

it("stays quiet on a paid account", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = { ...spent, free: false };
	renderNotice();
	expect(screen.queryByTestId("map-free-notice")).toBeNull();
});

it("states the live limit when staff allow more than one map", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = { ...spent, maps: { limit: 2, used: 2 } };
	renderNotice();
	const text = screen.getByTestId("map-free-notice").textContent ?? "";
	expect(text).toContain(
		"You have used this month's 2 free maps. The map in this presentation keeps its current version until ",
	);
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

it("states no number when staff set the map limit to 0", () => {
	state.sample = { data: { is_sample: false }, isSuccess: true };
	state.allowance = { ...spent, maps: { limit: 0, used: 0 } };
	renderNotice();
	const text = screen.getByTestId("map-free-notice").textContent ?? "";
	expect(text).toContain(
		"You have used this month's free maps. The map in this presentation keeps its current version until ",
	);
	expect(text).not.toContain(" 0 ");
});
