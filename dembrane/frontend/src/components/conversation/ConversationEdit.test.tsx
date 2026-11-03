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
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const { summarize, title, toastError, notify } = vi.hoisted(() => ({
	notify: vi.fn(),
	summarize: vi.fn(),
	title: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	generateConversationSummary: summarize,
	generateConversationTitle: title,
}));
vi.mock("../common/Toaster", () => ({
	toast: { error: toastError, info: vi.fn(), success: vi.fn() },
}));
vi.mock("@/components/error/notifyError", () => ({ notifyError: notify }));
vi.mock("./hooks", () => ({
	useConversationEmails: () => ({ data: undefined }),
	useUpdateConversationByIdMutation: () => ({ mutateAsync: vi.fn() }),
	useUpdateConversationTagsMutation: () => ({ mutateAsync: vi.fn() }),
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

import { ConversationEdit } from "./ConversationEdit";

i18n.load("en-US", {});
i18n.activate("en-US");

beforeAll(() => {
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

const usedUp = {
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
};

const renderEdit = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/w/w1/projects/p1/conversations"]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId/conversations"
								element={
									<ConversationEdit
										conversation={
											{
												id: "c1",
												project_id: "p1",
												summary: "A summary",
												tags: [],
												title: "A title",
											} as unknown as Conversation
										}
										projectTags={[]}
										showSummary
									/>
								}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

it.each([
	["summary", "conversation-edit-summary-generate-button", summarize],
	["title", "conversation-edit-title-generate-button", title],
] as const)(
	"%s at a used-up AI budget opens the AI wall, with no failure toast",
	async (action, button, call) => {
		call.mockRejectedValueOnce(usedUp);
		renderEdit();
		await act(async () => {
			fireEvent.click(screen.getByTestId(button));
		});
		const modal = await screen.findByTestId("upgrade-modal");
		expect(modal.dataset.wall).toBe("ai_budget");
		expect(modal.dataset.action).toBe(action);
		expect(modal.dataset.resets).toBe("2026-12-01T00:00:00Z");
		expect(toastError).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	},
);

it("any other summary failure still toasts, and opens no wall", async () => {
	summarize.mockRejectedValueOnce(new Error("boom"));
	renderEdit();
	await act(async () => {
		fireEvent.click(
			screen.getByTestId("conversation-edit-summary-generate-button"),
		);
	});
	await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});
