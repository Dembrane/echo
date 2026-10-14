// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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

// What the queries return. Tests change these before rendering.
let conversationQuery: { data?: unknown; isError: boolean; isLoading: boolean };
let projectLoading: boolean;
let chunks: { id: string }[];

vi.mock("@/portal/components/conversation/queries", () => ({
	useConversationChunksQuery: () => ({ data: chunks }),
	useConversationQuery: () => conversationQuery,
}));
vi.mock("@/portal/hooks/useParticipantProjectById", () => ({
	useParticipantProjectById: () => ({
		data: { id: "p1" },
		isLoading: projectLoading,
	}),
}));
vi.mock("./useUploadConversationTextChunk", () => ({
	useUploadConversationTextChunk: () => ({
		isPending: false,
		mutate: () => {},
	}),
}));

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

beforeEach(() => {
	conversationQuery = { data: { id: "c1" }, isError: false, isLoading: false };
	projectLoading = false;
	chunks = [{ id: "chunk1" }];
});

afterEach(() => {
	cleanup();
	navigate.mockReset();
	finish.mockReset();
	capture.mockReset();
	toastError.mockReset();
});

const renderText = () =>
	render(
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
		</I18nProvider>,
	);

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

it("shows the loading screen while the conversation or project loads", () => {
	conversationQuery = { isError: false, isLoading: true };
	renderText();
	expect(screen.queryByTestId("portal-text-input-textarea")).toBeNull();
	cleanup();

	conversationQuery = { data: { id: "c1" }, isError: false, isLoading: false };
	projectLoading = true;
	renderText();
	expect(screen.queryByTestId("portal-text-input-textarea")).toBeNull();
});

it("shows the error view when the conversation fails to load or is missing", () => {
	conversationQuery = { isError: true, isLoading: false };
	renderText();
	expect(screen.getByText("Something went wrong")).toBeTruthy();
	cleanup();

	conversationQuery = { isError: false, isLoading: false };
	renderText();
	expect(screen.getByText("Something went wrong")).toBeTruthy();
});

it("shows Finish only with chunks and nothing typed", () => {
	chunks = [];
	renderText();
	expect(screen.queryByTestId("portal-text-finish-button")).toBeNull();
	cleanup();

	chunks = [{ id: "chunk1" }];
	renderText();
	expect(screen.getByTestId("portal-text-finish-button")).toBeTruthy();
	fireEvent.change(screen.getByTestId("portal-text-input-textarea"), {
		target: { value: "hello" },
	});
	expect(screen.queryByTestId("portal-text-finish-button")).toBeNull();
});
