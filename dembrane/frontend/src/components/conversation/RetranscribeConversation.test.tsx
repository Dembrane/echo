// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const { retranscribe, toastError } = vi.hoisted(() => ({
	retranscribe: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	getVerificationArtefacts: vi.fn(async () => []),
	retranscribeConversation: retranscribe,
}));
vi.mock("@/components/common/Toaster", () => ({
	toast: { error: toastError, success: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("../project/hooks", () => ({
	useProjectById: () => ({ data: { anonymize_transcripts: false } }),
}));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		aiAction,
		opened,
		resetsAt,
		wallKey,
	}: {
		aiAction?: string;
		opened: boolean;
		resetsAt?: string | null;
		wallKey: string;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-action={aiAction}
				data-resets={resetsAt ?? ""}
			/>
		) : null,
}));

import { RetranscribeConversationModalActionIcon } from "./RetranscribeConversation";

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
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const renderIcon = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider
					client={
						new QueryClient({
							defaultOptions: {
								mutations: { retry: false },
								queries: { retry: false },
							},
						})
					}
				>
					<MemoryRouter initialEntries={["/w/ws-1/projects/p-1"]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId"
								element={
									<RetranscribeConversationModalActionIcon
										conversationId="c-1"
										conversationName="Interview"
									/>
								}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const retranscribeNow = async () => {
	fireEvent.click(screen.getByTestId("transcript-retranscribe-button"));
	const confirm = await screen.findByTestId(
		"transcript-retranscribe-confirm-button",
	);
	await act(async () => {
		fireEvent.click(confirm);
	});
};

it("closes and opens the AI wall, with no failure toast, when the AI budget is used up", async () => {
	retranscribe.mockRejectedValueOnce({
		response: {
			data: {
				code: "billing.tier_limit",
				detail: {
					error: "FREE_TIER_LIMIT",
					limit: "ai_budget",
					resets_at: "2026-12-01T00:00:00Z",
				},
				params: { limit: "ai_budget" },
			},
			status: 402,
		},
	});
	const unhandled = vi.fn();
	process.on("unhandledRejection", unhandled);
	renderIcon();
	await retranscribeNow();
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	expect(modal.dataset.action).toBe("retranscribe");
	expect(modal.dataset.resets).toBe("2026-12-01T00:00:00Z");
	await waitFor(() =>
		expect(
			screen.queryByTestId("transcript-retranscribe-confirm-button"),
		).toBeNull(),
	);
	expect(toastError).not.toHaveBeenCalled();
	await new Promise((r) => setTimeout(r, 0));
	process.off("unhandledRejection", unhandled);
	expect(unhandled).not.toHaveBeenCalled();
});

it("still toasts any other failure, and opens no wall", async () => {
	retranscribe.mockRejectedValueOnce(new Error("boom"));
	renderIcon();
	await retranscribeNow();
	await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});
