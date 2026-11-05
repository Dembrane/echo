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

const { summarize, title, toastError, notify, update, updateOpts } = vi.hoisted(
	() => ({
		notify: vi.fn(),
		updateOpts: [] as { onError?: (error: unknown) => void }[],
		summarize: vi.fn(),
		title: vi.fn(),
		toastError: vi.fn(),
		update: vi.fn(),
	}),
);

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
	useUpdateConversationByIdMutation: (opts: {
		onError?: (e: unknown) => void;
	}) => {
		updateOpts.push(opts);
		return { mutateAsync: update };
	},
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

const filled = { summary: "A summary", title: "A title" };

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

const renderEdit = (fields: { summary: string; title: string } = filled) =>
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
												tags: [],
												...fields,
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
	[
		"summary_again",
		"conversation-edit-summary-generate-button",
		summarize,
		filled,
	],
	["title_again", "conversation-edit-title-generate-button", title, filled],
	[
		"summary",
		"conversation-edit-summary-generate-button",
		summarize,
		{ summary: "", title: "" },
	],
	[
		"title",
		"conversation-edit-title-generate-button",
		title,
		{ summary: "A summary", title: "" },
	],
] as const)(
	"%s at a used-up AI budget opens the AI wall, with no failure toast",
	async (action, button, call, fields) => {
		call.mockRejectedValueOnce(usedUp);
		renderEdit(fields);
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

it("clearing the summary at a used-up AI budget opens the wall and keeps the summary", async () => {
	update.mockRejectedValueOnce(usedUp);
	renderEdit();
	const box = screen.getByTestId(
		"conversation-edit-summary-input",
	) as HTMLTextAreaElement;
	fireEvent.change(box, { target: { value: "" } });
	const modal = await screen.findByTestId("upgrade-modal", undefined, {
		timeout: 3000,
	});
	expect(modal.dataset.action).toBe("summary_again");
	await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
	expect(update.mock.calls[0]?.[0].payload.summary).toBe("");
	// The rest of the form still saves, leaving the summary as it was.
	expect(update.mock.calls[1]?.[0].payload).not.toHaveProperty("summary");
	expect(box.value).toBe("A summary");
	expect(toastError).not.toHaveBeenCalled();
});

it("a refused save toasts nothing for the AI budget, and still toasts any other failure", () => {
	renderEdit();
	const onError = updateOpts.at(-1)?.onError;
	onError?.(usedUp);
	expect(notify).not.toHaveBeenCalled();
	onError?.(new Error("boom"));
	expect(notify).toHaveBeenCalledTimes(1);
});

it("a title edit sends no summary, so a stale one never overwrites a newer one", async () => {
	renderEdit();
	fireEvent.change(screen.getByTestId("conversation-edit-title-input"), {
		target: { value: "A new title" },
	});
	await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1), {
		timeout: 3000,
	});
	expect(update.mock.calls[0]?.[0].payload).toMatchObject({
		title: "A new title",
	});
	expect(update.mock.calls[0]?.[0].payload).not.toHaveProperty("summary");
});

it("a summary edit sends the summary", async () => {
	renderEdit();
	fireEvent.change(screen.getByTestId("conversation-edit-summary-input"), {
		target: { value: "Edited by hand." },
	});
	await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1), {
		timeout: 3000,
	});
	expect(update.mock.calls[0]?.[0].payload.summary).toBe("Edited by hand.");
});
