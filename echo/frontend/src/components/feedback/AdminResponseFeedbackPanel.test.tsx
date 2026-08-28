// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const rows = [
	{
		comment: null,
		context: { chat_mode: "overview", project_chat_id: "chat-1" },
		date_created: "2026-08-20T10:00:00Z",
		id: "fb-1",
		org_name: "City of Utrecht",
		project_id: "proj-1",
		project_name: "Community Workshop",
		rating: "up" as const,
		reasons: [] as string[],
		response_snapshot: "The answer was helpful.",
		target_id: "m-1",
		target_type: "chat_message" as const,
		user_email: "host@dembrane.com",
		user_name: "Sam Host",
		workspace_id: "ws-1",
		workspace_name: "Civic Team",
	},
	{
		comment: "The dates are off",
		context: {
			chat_mode: "agentic",
			project_chat_id: "chat-2",
			prompt: "When did the forum take place?",
			session_replay_url: "https://eu.posthog.com/replay/abc",
		},
		date_created: "2026-08-21T10:00:00Z",
		id: "fb-2",
		org_name: null,
		project_id: "proj-2",
		project_name: "Civic Forum",
		rating: "down" as const,
		reasons: ["incorrect"],
		response_snapshot: "The response had wrong dates.",
		target_id: "m-2",
		target_type: "chat_message" as const,
		user_email: "participant@example.com",
		user_name: null,
		workspace_id: "ws-2",
		workspace_name: "Forum Team",
	},
];

vi.mock("./hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("./hooks")>()),
	useAdminResponseFeedback: () => ({
		data: { items: rows, limit: 50, page: 1, total: 143 },
		isLoading: false,
		refetch: vi.fn(),
	}),
}));

import { AdminResponseFeedbackPanel } from "./AdminResponseFeedbackPanel";

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

	// Table.ScrollContainer uses Mantine's ScrollArea, which observes size via
	// ResizeObserver; jsdom has no implementation.
	window.ResizeObserver =
		window.ResizeObserver ||
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
});
afterEach(() => cleanup());

describe("AdminResponseFeedbackPanel", () => {
	it("lists compact rows and opens a drawer with the detail, without leaking emails in the list", async () => {
		wrap(<AdminResponseFeedbackPanel />);
		const table = within(screen.getByRole("table"));

		expect(screen.getByTestId("response-feedback-range").textContent).toBe(
			"Showing 1-50 of 143",
		);
		expect(table.getByText("Incorrect or made up")).toBeTruthy();
		expect(table.getByText("When did the forum take place?")).toBeTruthy();
		expect(table.getByText("City of Utrecht")).toBeTruthy();
		expect(
			table.getByText("Civic Team / Community Workshop · Sam Host"),
		).toBeTruthy();
		expect(
			table.getByText("Forum Team / Civic Forum · example.com"),
		).toBeTruthy();
		expect(screen.queryByText("The dates are off")).toBeNull();
		expect(screen.queryByText("participant@example.com")).toBeNull();

		fireEvent.click(screen.getByTestId("response-feedback-open-fb-2"));
		const drawer = within(
			await screen.findByTestId("response-feedback-drawer"),
		);
		expect(
			await drawer.findByText("The response had wrong dates."),
		).toBeTruthy();
		expect(drawer.getByText("The dates are off")).toBeTruthy();
		expect(drawer.getByText("Host's feedback")).toBeTruthy();
		expect(
			within(drawer.getByTestId("response-feedback-exchange")).getByText(
				"When did the forum take place?",
			),
		).toBeTruthy();
		expect(drawer.getByText("Agentic")).toBeTruthy();
		expect(drawer.getByText("participant@example.com")).toBeTruthy();
		expect(
			drawer.getByText("Open replay").closest("a")?.getAttribute("href"),
		).toBe("https://eu.posthog.com/replay/abc");

		// Previous steps to the first row; next is then disabled at the start.
		fireEvent.click(drawer.getByTestId("response-feedback-previous"));
		expect(await drawer.findByText("The answer was helpful.")).toBeTruthy();
		expect(drawer.getByText("Sam Host")).toBeTruthy();
		expect(drawer.getByText("host@dembrane.com")).toBeTruthy();
		expect(
			(drawer.getByTestId("response-feedback-previous") as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
});
