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
				translations: { "en-US": { label: `Label ${key}` } },
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
	state.mutateAsync.mockReset();
	state.toastError.mockReset();
	state.project = {};
	state.topics = ["gems", "actions"];
});

const page = () => (
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
	</I18nProvider>
);
const renderPage = () => render(page());

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

// ECHO-1052: one topic starts at once; several are clear buttons, each with what it gives.
it("starts generating the one selected topic at once, with no picker", async () => {
	state.topics = ["agreements"];
	state.mutateAsync.mockResolvedValue({ id: "a-1" });
	renderPage();
	await vi.waitFor(() =>
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ topicKey: "agreements" }),
		),
	);
	expect(screen.queryByTestId("portal-verify-selection-container")).toBeNull();
});

it("shows several topics as buttons with their label and one line each", () => {
	state.topics = ["agreements", "heard", "my-own-topic"];
	renderPage();
	const tableCheck = screen.getByTestId("portal-verify-topic-agreements");
	expect(tableCheck.textContent).toContain("Label agreements");
	expect(tableCheck.textContent).toContain(
		"What this group mostly agreed on, and what differed.",
	);
	expect(screen.getByTestId("portal-verify-topic-heard").textContent).toContain(
		"What this person or group told us, in their own words.",
	);
	// A host's own topic has its label and no invented description.
	expect(
		screen.getByTestId("portal-verify-topic-my-own-topic").textContent,
	).toBe("Label my-own-topic");
	fireEvent.click(tableCheck);
	expect(tableCheck.getAttribute("aria-pressed")).toBe("true");
	expect(state.mutateAsync).not.toHaveBeenCalled();
});

it("tries the single topic once, and doesn't retry by itself after a failure", async () => {
	state.topics = ["agreements"];
	state.mutateAsync.mockRejectedValue(new Error("boom"));
	const view = renderPage();
	await vi.waitFor(() => expect(state.toastError).toHaveBeenCalled());
	view.rerender(page());
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(state.mutateAsync).toHaveBeenCalledTimes(1);
});

it("drops the choice when the host removes that topic", () => {
	const view = renderPage();
	fireEvent.click(screen.getByTestId("portal-verify-topic-gems"));
	const next = screen.getByTestId("portal-verify-selection-next-button");
	expect(next).toHaveProperty("disabled", false);

	state.topics = ["actions", "heard"];
	view.rerender(page());
	expect(next).toHaveProperty("disabled", true);
});

it("goes to the instructions once the chosen topic is generated", async () => {
	state.mutateAsync.mockResolvedValue({ id: "a-1" });
	renderPage();
	pickAndContinue();
	await vi.waitFor(() =>
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: "c-1", topicKey: "gems" }),
		),
	);
	expect(screen.queryByTestId("portal-verify-selection-container")).toBeNull();
	expect(state.toastError).not.toHaveBeenCalled();
});
