// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { FreePopcorn } from "./hooks";
import { PopcornFreeNotice } from "./PopcornFreeNotice";

const allowance: { resets_at: string | null } = {
	resets_at: "2026-11-01T00:00:00Z",
};

vi.mock("@/hooks/useFreeAllowance", () => ({
	useFreeAllowance: () => ({ data: { free: true, ...allowance } }),
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
	allowance.resets_at = "2026-11-01T00:00:00Z";
});

const renderNotice = (status: FreePopcorn | null | undefined) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter>
						<PopcornFreeNotice
							status={status}
							workspaceId="w1"
							projectId="p1"
						/>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

it("renders nothing without a free status", () => {
	for (const status of [null, undefined]) {
		renderNotice(status);
		expect(screen.queryByTestId("popcorn-free-meter")).toBeNull();
		expect(screen.queryByTestId("popcorn-free-notice")).toBeNull();
		expect(screen.queryByText(/analyses/)).toBeNull();
		cleanup();
	}
});

it("shows the meter and no button while analyses remain", () => {
	renderNotice({ exhausted: false, limit: 12, used: 3 });
	expect(screen.getByText("3 of 12 analyses used this month")).toBeTruthy();
	expect(screen.queryByRole("button")).toBeNull();
});

it("says the analyses are used and opens the wall from its button", () => {
	renderNotice({ exhausted: true, limit: 12, used: 12 });
	const text = screen.getByTestId("popcorn-free-notice").textContent ?? "";
	expect(text).toContain(
		"You have used this month's free popcorn analyses. The results stay here. Analysis starts again on ",
	);
	expect(text).toContain("2026");
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "See upgrade options" }));
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("popcorn_cap");
	expect(modal.dataset.tier).toBe("free");
});

it("ends after the results line without a reset date", () => {
	allowance.resets_at = null;
	renderNotice({ exhausted: true, limit: 12, used: 12 });
	const text = screen.getByTestId("popcorn-free-notice").textContent ?? "";
	expect(text).toContain(
		"You have used this month's free popcorn analyses. The results stay here.",
	);
	expect(text).not.toContain("starts again");
});
