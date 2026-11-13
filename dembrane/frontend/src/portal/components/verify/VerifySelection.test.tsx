// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { VerifySelection } from "./VerifySelection";

const state = vi.hoisted(() => ({
	mutateAsync: vi.fn(),
	project: {} as Record<string, unknown>,
	toastError: vi.fn(),
	topics: ["gems", "actions"],
}));

vi.mock("@/portal/hooks/useParticipantProjectById", () => ({
	useParticipantProjectById: () => ({
		data: { id: "p-1", language: "en", ...state.project },
		isLoading: false,
	}),
}));
vi.mock("./hooks", () => ({
	useGenerateVerificationArtefactMutation: () => ({
		isPending: false,
		mutateAsync: state.mutateAsync,
	}),
	useVerificationTopics: () => ({
		data: {
			available_topics: state.topics.map((key) => ({
				key,
				translations: { "en-US": { label: key } },
			})),
			selected_topics: state.topics,
		},
		isLoading: false,
	}),
}));
vi.mock("@/components/common/Toaster", () => ({
	toast: { error: state.toastError, success: vi.fn() },
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ iso639_1: "en" }),
}));

const refused = {
	response: {
		data: {
			action: "none",
			code: "portal.ai_unavailable",
			detail: "Not available right now.",
		},
		status: 403,
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
});

afterEach(() => {
	cleanup();
	state.mutateAsync.mockReset();
	state.toastError.mockReset();
	state.project = {};
	state.topics = ["gems", "actions"];
});

const renderPage = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/p-1/conversation/c-1/verify"]}>
					<Routes>
						<Route
							path="/:projectId/conversation/:conversationId/verify"
							element={<VerifySelection />}
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const pickAndContinue = () => {
	fireEvent.click(screen.getByTestId("portal-verify-topic-gems"));
	fireEvent.click(screen.getByTestId("portal-verify-selection-next-button"));
};

it("shows the line, not a failure toast, when generation is refused", async () => {
	state.mutateAsync.mockRejectedValue(refused);
	renderPage();
	pickAndContinue();
	expect(await screen.findByText("Not available right now")).toBeTruthy();
	expect(state.toastError).not.toHaveBeenCalled();
	expect(
		screen
			.getByTestId("portal-verify-selection-next-button")
			.hasAttribute("disabled"),
	).toBe(true);
});

it("shows the line when the single topic's automatic generation is refused", async () => {
	state.topics = ["gems"];
	state.mutateAsync.mockRejectedValue(refused);
	renderPage();
	expect(await screen.findByText("Not available right now")).toBeTruthy();
	expect(state.toastError).not.toHaveBeenCalled();
});

it("does not generate and shows the line when the project has no AI", () => {
	state.topics = ["gems"];
	state.project = { is_ai_available: false };
	renderPage();
	expect(screen.getByText("Not available right now")).toBeTruthy();
	expect(state.mutateAsync).not.toHaveBeenCalled();
});

it("still toasts other generation failures", async () => {
	state.mutateAsync.mockRejectedValue(new Error("boom"));
	renderPage();
	pickAndContinue();
	await vi.waitFor(() => expect(state.toastError).toHaveBeenCalledTimes(1));
	expect(screen.queryByText("Not available right now")).toBeNull();
});
