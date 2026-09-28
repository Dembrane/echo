// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
	ParticipantInitiateForm,
	portalHasNothingToAsk,
} from "./ParticipantInitiateForm";

const navigate = vi.fn();
const initiate = vi.fn();

vi.mock("posthog-js", () => ({
	default: { capture: () => {} },
}));

vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => navigate,
}));

vi.mock("@/lib/api", () => ({
	initiateConversation: (...args: unknown[]) => initiate(...args),
}));

vi.mock("./hooks", () => ({
	useInitiateConversationMutation: () => ({
		data: undefined,
		error: null,
		isError: false,
		isPending: false,
		isSuccess: false,
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

afterEach(() => {
	cleanup();
	navigate.mockClear();
	initiate.mockClear();
});

const project = (overrides: Partial<Project> = {}) =>
	({
		default_conversation_ask_for_participant_name: false,
		id: "p1",
		tags: [],
		...overrides,
	}) as unknown as Project;

const wrap = (p: Project) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/en-US/p1/start"]}>
					<ParticipantInitiateForm project={p} />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

it("knows when the screen has nothing to ask", () => {
	expect(portalHasNothingToAsk(project())).toBe(true);
	expect(
		portalHasNothingToAsk(
			project({ default_conversation_ask_for_participant_name: true }),
		),
	).toBe(false);
	expect(
		portalHasNothingToAsk(
			project({
				tags: [{ id: "t1", text: "One" }] as unknown as Project["tags"],
			}),
		),
	).toBe(false);
});

it("starts the conversation itself when nothing is asked", async () => {
	initiate.mockResolvedValue({ id: "c1" });
	wrap(project());

	await waitFor(() => expect(initiate).toHaveBeenCalledTimes(1));
	await waitFor(() =>
		expect(navigate).toHaveBeenCalledWith("/p1/conversation/c1"),
	);
	// No question was asked, so no button was offered.
	expect(screen.queryByTestId("portal-initiate-next-button")).toBeNull();
});

it("creates one conversation even if the form is torn down mid-request", async () => {
	// React's StrictMode remounts every component once in development, and a
	// re-render can swap this subtree's identity in production. Either way the
	// participant must not end up with two conversations, and must still be
	// sent onward when the first request lands.
	let resolveRequest: (value: { id: string }) => void = () => {};
	initiate.mockReturnValue(
		new Promise<{ id: string }>((resolve) => {
			resolveRequest = resolve;
		}),
	);

	const first = wrap(project());
	await waitFor(() => expect(initiate).toHaveBeenCalledTimes(1));
	first.unmount();

	wrap(project());
	resolveRequest({ id: "c1" });

	await waitFor(() =>
		expect(navigate).toHaveBeenCalledWith("/p1/conversation/c1"),
	);
	expect(initiate).toHaveBeenCalledTimes(1);
});

it("leaves the Continue button alone when the project asks for a name", () => {
	wrap(project({ default_conversation_ask_for_participant_name: true }));

	expect(initiate).not.toHaveBeenCalled();
	expect(screen.getByTestId("portal-initiate-next-button")).toBeTruthy();
});
