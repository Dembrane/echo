// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const setMutate = vi.fn();
const clearMutate = vi.fn();
vi.mock("@/components/feedback/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/feedback/hooks")>()),
	useClearResponseFeedbackMutation: () => ({ mutate: clearMutate }),
	useSetResponseFeedbackMutation: () => ({ mutate: setMutate }),
}));
vi.mock("posthog-js", () => ({
	default: {
		capture: vi.fn(),
		get_session_replay_url: () => "https://eu.posthog.com/replay/x",
	},
}));

import { ChatHistoryMessage } from "./ChatHistoryMessage";

const wrap = (ui: React.ReactElement) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter>{ui}</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");

	// MantineProvider reads the OS color scheme on mount; jsdom has no
	// matchMedia, so stub a minimal (always non-matching) implementation.
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
	setMutate.mockClear();
	clearMutate.mockClear();
});

const baseMessage = {
	_original: {} as ProjectChatMessage,
	content: "Hello there",
	metadata: [],
};

describe("ChatHistoryMessage feedback controls", () => {
	it("renders thumbs for an assistant message with a feedbackTargetId", () => {
		wrap(
			<ChatHistoryMessage
				message={{ ...baseMessage, id: "m-1", role: "assistant" }}
				feedbackTargetId="m-1"
			/>,
		);
		expect(screen.getByTestId("response-feedback-up")).toBeTruthy();
	});

	it("does not render thumbs for an assistant message without a feedbackTargetId", () => {
		wrap(
			<ChatHistoryMessage
				message={{ ...baseMessage, id: "m-2", role: "assistant" }}
			/>,
		);
		expect(screen.queryByTestId("response-feedback-up")).toBeNull();
	});

	it("does not render thumbs for a user message even with a feedbackTargetId", () => {
		wrap(
			<ChatHistoryMessage
				message={{ ...baseMessage, id: "m-3", role: "user" }}
				feedbackTargetId="m-3"
			/>,
		);
		expect(screen.queryByTestId("response-feedback-up")).toBeNull();
	});
});
