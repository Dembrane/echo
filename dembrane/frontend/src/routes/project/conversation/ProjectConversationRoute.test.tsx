// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/errors/read";
import { ProjectConversationRoute } from "./ProjectConversationRoute";

const role = vi.hoisted(() => ({ current: "owner" }));
const summary = vi.hoisted(() => ({ current: null as string | null }));
// Set to make the conversation request fail.
const failure = vi.hoisted(() => ({ current: null as unknown }));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: role.current, tier: "free" },
	}),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => navigateMock,
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));
vi.mock("@/components/conversation/hooks", () => ({
	useConversationById: () =>
		failure.current
			? {
					data: undefined,
					error: failure.current,
					isError: true,
					isFetching: false,
					isLoading: false,
				}
			: {
					data: {
						id: "c1",
						is_finished: true,
						participant_name: "P",
						summary: summary.current,
					},
					isFetching: false,
					isLoading: false,
				},
	useConversationChunks: () => ({ data: [{ id: "k1" }] }),
	useConversationHasTranscript: () => ({ data: 1 }),
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({ data: { id: "p1", language: "en" } }),
}));
vi.mock("@/components/conversation/ConversationDangerZone", () => ({
	ConversationDangerZone: () => null,
}));
vi.mock("@/components/conversation/ConversationLink", () => ({
	ConversationLink: () => null,
}));
vi.mock("@/components/conversation/ConversationTranscriptSection", () => ({
	ConversationTranscriptSection: () => null,
}));
vi.mock("@/components/conversation/VerifiedArtefactsSection", () => ({
	VerifiedArtefactsSection: () => null,
}));
vi.mock("@/components/common/Markdown", () => ({
	Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	role.current = "owner";
	summary.current = null;
	failure.current = null;
	navigateMock.mockReset();
});

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

const renderConversation = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/w/w1/projects/p1/conversations/c1"]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId/conversations/:conversationId"
								element={<ProjectConversationRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

describe("ProjectConversationRoute summary role gating", () => {
	it.each([
		// /summarize needs project:update
		["owner", true],
		["member", true],
		["external", true],
		["observer", false],
	])("%s: generate summary %s", (r, canGenerate) => {
		role.current = r;
		renderConversation();
		expect(
			!!screen.queryByTestId("conversation-overview-generate-summary-button"),
		).toBe(canGenerate);
	});

	it.each([
		["member", true],
		["observer", false],
	])("%s: regenerate summary %s, copy always", (r, canGenerate) => {
		role.current = r;
		summary.current = "A summary";
		renderConversation();
		expect(
			!!screen.queryByTestId("conversation-overview-regenerate-summary-button"),
		).toBe(canGenerate);
		expect(
			screen.getByTestId("conversation-overview-copy-summary-button"),
		).toBeTruthy();
		expect(screen.getByText("A summary")).toBeTruthy();
	});
});

describe("ProjectConversationRoute when the conversation is gone", () => {
	it("a deleted conversation says so instead of showing an empty page", () => {
		failure.current = new ApiRequestError(404, {
			code: "conversation.not_found",
		});
		renderConversation();
		expect(screen.queryByText("Untitled conversation")).toBeNull();
		expect(
			screen.getByText("This conversation is no longer available"),
		).toBeTruthy();
		fireEvent.click(screen.getByText("Back to conversations"));
		expect(navigateMock).toHaveBeenCalledWith(
			"/w/w1/projects/p1/conversations",
		);
	});
});
