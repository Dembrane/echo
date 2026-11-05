// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ParticipantConversationAudioContent } from "./ParticipantConversationAudioContent";

const state = vi.hoisted(() => ({
	echoError: undefined as Error | undefined,
	project: {} as Record<string, unknown>,
}));

vi.mock("@ai-sdk/react", () => ({
	useChat: () => ({
		data: undefined,
		error: state.echoError,
		handleSubmit: vi.fn(),
		isLoading: false,
		messages: [],
		status: state.echoError ? "error" : "ready",
	}),
}));
vi.mock("./hooks", () => ({
	useConversationQuery: () => ({ data: undefined }),
	useConversationRepliesQuery: () => ({ data: [] }),
	useParticipantProjectById: () => ({
		data: {
			id: "p-1",
			is_verify_enabled: true,
			is_verify_on_finish_enabled: true,
			...state.project,
		},
	}),
}));
vi.mock("./verify/hooks", () => ({
	useConversationArtefacts: () => ({ data: [] }),
}));
vi.mock("./verify/VerifiedArtefactsList", () => ({
	VerifiedArtefactsList: () => null,
}));
vi.mock("@/hooks/useLoadNotification", () => ({
	useLoadNotification: vi.fn(),
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ iso639_1: "en" }),
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
});

afterEach(() => {
	cleanup();
	state.echoError = undefined;
	state.project = {};
});

const renderPage = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/p-1/conversation/c-1"]}>
					<Routes>
						<Route
							path="/:projectId/conversation/:conversationId"
							element={
								<Outlet context={{ isRecording: true, recordingTime: 120 }} />
							}
						>
							<Route index element={<ParticipantConversationAudioContent />} />
						</Route>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

it("links the verification banner while AI is available", () => {
	renderPage();
	expect(screen.getByText("Verification required").closest("a")).toBeTruthy();
	expect(screen.queryByText("Not available right now")).toBeNull();
});

it("replaces the verification banner's link with the line when AI is not available", () => {
	state.project = { is_ai_available: false };
	renderPage();
	expect(screen.getByText("Not available right now")).toBeTruthy();
	expect(screen.queryByRole("link")).toBeNull();
});

// useChat puts the refused response's body in the error message.
it("shows the line, not the generic error, when Explore is refused", () => {
	state.echoError = new Error(
		JSON.stringify({
			action: "none",
			code: "portal.ai_unavailable",
			detail: "Not available right now.",
		}),
	);
	renderPage();
	expect(screen.getByText("Not available right now")).toBeTruthy();
	expect(screen.queryByText(/Something went wrong/)).toBeNull();
});

it("keeps the generic error for other Explore failures", () => {
	state.echoError = new Error("Internal Server Error");
	renderPage();
	expect(screen.getByText(/Something went wrong/)).toBeTruthy();
	expect(screen.queryByText("Not available right now")).toBeNull();
});
