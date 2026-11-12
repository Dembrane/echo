// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
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
import { ParticipantConversationText } from "./ParticipantConversationText";

const navigate = vi.fn();
const finish = vi.fn();
const capture = vi.fn();
const toastError = vi.fn();

vi.mock("posthog-js", () => ({
	default: { capture: (...args: unknown[]) => capture(...args) },
}));

vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => navigate,
}));

vi.mock("@/hooks/useElementOnScreen", () => ({
	useElementOnScreen: () => [{ current: null }, false],
}));

vi.mock("@/lib/api", () => ({
	finishConversation: (...args: unknown[]) => finish(...args),
}));

vi.mock("@/components/common/Toaster", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args) },
}));

vi.mock("@/portal/components/conversation/ConversationMessages", () => ({
	ConversationMessages: () => null,
}));

vi.mock("@/components/project/ProjectQRCode", () => ({
	useProjectSharingLink: () => null,
}));

const state: {
	aiAvailable: boolean;
	uploadError: unknown;
	chunks: { id: string }[];
} = {
	aiAvailable: true,
	chunks: [{ id: "chunk1" }],
	uploadError: null,
};
const mutate = vi.fn();

vi.mock("@/portal/hooks", () => ({
	useConversationChunksQuery: () => ({ data: state.chunks }),
	useConversationQuery: () => ({
		data: { id: "c1" },
		isError: false,
		isLoading: false,
	}),
	useParticipantProjectById: () => ({
		data: { id: "p1", is_ai_available: state.aiAvailable },
		isLoading: false,
	}),
	useUploadConversationTextChunk: () => ({
		error: state.uploadError,
		isPending: false,
		mutate: (...args: unknown[]) => mutate(...args),
	}),
}));

const aiRefusal = {
	response: {
		data: {
			code: "billing.tier_limit",
			detail: { error: "FREE_TIER_LIMIT", limit: "ai_budget" },
			params: { limit: "ai_budget" },
		},
		status: 402,
	},
};

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
		};
	}
});

afterEach(() => {
	cleanup();
	state.aiAvailable = true;
	state.uploadError = null;
	state.chunks = [{ id: "chunk1" }];
	mutate.mockReset();
	navigate.mockReset();
	finish.mockReset();
	capture.mockReset();
	toastError.mockReset();
});

const tree = () => (
	<I18nProvider i18n={i18n}>
		<MantineProvider>
			<MemoryRouter initialEntries={["/p1/conversation/c1/text"]}>
				<Routes>
					<Route
						path="/:projectId/conversation/:conversationId/text"
						element={<ParticipantConversationText />}
					/>
				</Routes>
			</MemoryRouter>
		</MantineProvider>
	</I18nProvider>
);

const renderText = () => render(tree());

const confirmFinish = async () => {
	fireEvent.click(screen.getByTestId("portal-text-finish-button"));
	fireEvent.click(
		await screen.findByTestId("portal-text-finish-confirm-button"),
	);
};

it("finishes the conversation before navigating to the finish page", async () => {
	finish.mockResolvedValue({});
	renderText();
	await confirmFinish();

	await waitFor(() =>
		expect(navigate).toHaveBeenCalledWith("/p1/conversation/c1/finish"),
	);
	expect(finish).toHaveBeenCalledWith("c1");
	expect(finish.mock.invocationCallOrder[0]).toBeLessThan(
		navigate.mock.invocationCallOrder[0],
	);
	expect(capture).toHaveBeenCalledWith("conversation_finished", {
		conversation_id: "c1",
		project_id: "p1",
	});
});

it("stays on the page and shows an error when finish fails", async () => {
	finish.mockRejectedValue(new Error("boom"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	renderText();
	await confirmFinish();

	await waitFor(() => expect(toastError).toHaveBeenCalled());
	expect(navigate).not.toHaveBeenCalled();
	expect(capture).not.toHaveBeenCalledWith(
		"conversation_finished",
		expect.anything(),
	);
});

it("a refused submit shows the neutral notice instead of the text box", () => {
	state.uploadError = aiRefusal;
	renderText();
	expect(
		screen.getByText("This project isn't taking responses right now."),
	).toBeTruthy();
	expect(screen.queryByTestId("portal-text-input-textarea")).toBeNull();
	expect(screen.queryByTestId("portal-text-submit-button")).toBeNull();
	expect(document.body.textContent).not.toMatch(/budget|plan|upgrade/i);
	// What was already sent can still be finished.
	expect(screen.getByTestId("portal-text-finish-button")).toBeTruthy();
});

it("shows the notice up front when nothing was sent yet and responses stopped", () => {
	state.aiAvailable = false;
	state.chunks = [];
	renderText();
	expect(
		screen.getByText("This project isn't taking responses right now."),
	).toBeTruthy();
	expect(screen.queryByTestId("portal-text-input-textarea")).toBeNull();
});

it("keeps the box for a conversation already under way, like the audio page", () => {
	state.aiAvailable = false;
	renderText();
	expect(screen.getByTestId("portal-text-input-textarea")).toBeTruthy();
});

const typeAndSubmit = (value: string) => {
	fireEvent.change(screen.getByTestId("portal-text-input-textarea"), {
		target: { value },
	});
	fireEvent.click(screen.getByTestId("portal-text-submit-button"));
};

it("clears the box only once the text is accepted", () => {
	renderText();
	typeAndSubmit("My idea");
	const box = screen.getByTestId(
		"portal-text-input-textarea",
	) as HTMLTextAreaElement;
	expect(box.value).toBe("My idea");
	const opts = mutate.mock.calls[0]?.[1] as {
		onSuccess: (chunk: unknown) => void;
	};
	act(() => opts.onSuccess({ id: "k1" }));
	expect(box.value).toBe("");
});

it("a refused submit keeps the unsent text, read-only with a copy button", () => {
	const view = renderText();
	typeAndSubmit("My idea");
	state.uploadError = aiRefusal;
	view.rerender(tree());
	expect(
		screen.getByText("This project isn't taking responses right now."),
	).toBeTruthy();
	const kept = screen.getByTestId(
		"portal-text-unsent-textarea",
	) as HTMLTextAreaElement;
	expect(kept.value).toBe("My idea");
	expect(kept.readOnly).toBe(true);
	expect(screen.getByTestId("portal-text-unsent-copy-button")).toBeTruthy();
	expect(screen.queryByTestId("portal-text-submit-button")).toBeNull();
	// What was sent before can still be finished.
	expect(screen.getByTestId("portal-text-finish-button")).toBeTruthy();
});

it("text accepted within the wrap-up grace is sent, then the notice shows", () => {
	renderText();
	typeAndSubmit("Last words");
	const opts = mutate.mock.calls[0]?.[1] as {
		onSuccess: (chunk: unknown) => void;
	};
	act(() => opts.onSuccess({ id: "k1", recording_stop: "ai_budget" }));
	expect(
		screen.getByText("This project isn't taking responses right now."),
	).toBeTruthy();
	expect(screen.queryByTestId("portal-text-unsent-textarea")).toBeNull();
	expect(screen.getByTestId("portal-text-finish-button")).toBeTruthy();
});
