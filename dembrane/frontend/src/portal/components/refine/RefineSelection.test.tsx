// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { RefineSelection } from "./RefineSelection";

const state = vi.hoisted(() => ({
	navigate: vi.fn(),
	project: {} as Record<string, unknown>,
}));

vi.mock("@/portal/hooks/useParticipantProjectById", () => ({
	useParticipantProjectById: () => ({
		data: { id: "p-1", ...state.project },
		isLoading: false,
	}),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => state.navigate,
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
	state.navigate.mockReset();
	localStorage.clear();
});

const renderPage = (project: Record<string, unknown>) => {
	state.project = {
		is_get_reply_enabled: true,
		is_verify_enabled: true,
		...project,
	};
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/p-1/conversation/c-1/refine"]}>
					<Routes>
						<Route
							path="/:projectId/conversation/:conversationId/refine"
							element={<RefineSelection />}
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
};

it("locks Verify and Explore with the line when AI is not available", () => {
	renderPage({ is_ai_available: false });
	const verify = screen.getByTestId("portal-echo-verify-card");
	const explore = screen.getByTestId("portal-echo-explore-card");
	expect(verify.getAttribute("aria-disabled")).toBe("true");
	expect(explore.getAttribute("aria-disabled")).toBe("true");
	expect(screen.getAllByText("Not available right now")).toHaveLength(2);

	fireEvent.click(verify);
	fireEvent.click(explore);
	expect(state.navigate).not.toHaveBeenCalled();
	expect(localStorage.getItem("cooldown_c-1_echo")).toBeNull();
});

it.each([
	["true", { is_ai_available: true }],
	["absent", {}],
])("leaves the cards open when is_ai_available is %s", (_label, project) => {
	renderPage(project);
	const verify = screen.getByTestId("portal-echo-verify-card");
	expect(verify.getAttribute("aria-disabled")).toBeNull();
	expect(
		screen
			.getByTestId("portal-echo-explore-card")
			.getAttribute("aria-disabled"),
	).toBeNull();
	expect(screen.queryByText("Not available right now")).toBeNull();

	fireEvent.click(verify);
	expect(state.navigate).toHaveBeenCalledWith("/p-1/conversation/c-1/verify");
});
