// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationDangerZone } from "./ConversationDangerZone";

const navigateMock = vi.hoisted(() => vi.fn());
const deleteMutate = vi.hoisted(() => vi.fn());
const role = vi.hoisted(() => ({ current: "owner" }));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => navigateMock,
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: role.current, tier: "free" },
	}),
}));
vi.mock("@/components/conversation/MoveConversationButton", () => ({
	MoveConversationButton: () => null,
}));
vi.mock("./hooks", () => ({
	useDeleteConversationByIdMutation: () => ({
		isPending: false,
		mutate: deleteMutate,
	}),
}));
vi.mock("@/components/common/ConfirmModal", () => ({
	ConfirmModal: (props: {
		opened: boolean;
		onConfirm: () => void;
		"data-testid"?: string;
	}) =>
		props.opened ? (
			<button
				type="button"
				data-testid={`${props["data-testid"]}-confirm`}
				onClick={props.onConfirm}
			>
				confirm
			</button>
		) : null,
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	deleteMutate.mockReset();
	role.current = "owner";
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

const conversation = { id: "c1" } as Conversation;

const renderZone = (c: Conversation = conversation) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/w/w1/projects/p1/conversations/c1"]}>
					<Routes>
						<Route
							path="/w/:workspaceId/projects/:projectId/conversations/:conversationId"
							element={<ConversationDangerZone conversation={c} />}
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const confirmDelete = () => {
	fireEvent.click(screen.getByTestId("conversation-delete-button"));
	fireEvent.click(screen.getByTestId("conversation-delete-modal-confirm"));
};

describe("ConversationDangerZone delete", () => {
	it("stays on the conversation when the delete is refused", () => {
		deleteMutate.mockImplementation(
			(_id: string, opts?: { onError?: (e: Error) => void }) =>
				opts?.onError?.(new Error("403")),
		);
		renderZone();
		confirmDelete();
		expect(navigateMock).not.toHaveBeenCalled();
		expect(deleteMutate).toHaveBeenCalledWith("c1", expect.anything());
	});

	it("navigates to the list once the delete succeeds", () => {
		deleteMutate.mockImplementation(
			(_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
		);
		renderZone();
		confirmDelete();
		expect(navigateMock).toHaveBeenCalledWith(
			"/w/w1/projects/p1/conversations",
		);
	});
});

describe("ConversationDangerZone role gating", () => {
	it.each([
		// conversation:delete: members and admins, not outsiders
		["owner", true],
		["admin", true],
		["member", true],
		["external", false],
		["observer", false],
	])("%s: delete visible %s", (r, canDelete) => {
		role.current = r;
		renderZone();
		expect(!!screen.queryByTestId("conversation-delete-button")).toBe(
			canDelete,
		);
		// Download stays available to every reader.
		expect(
			screen.getByTestId("conversation-download-audio-button"),
		).toBeTruthy();
	});
});

describe("ConversationDangerZone download", () => {
	it("a text-only conversation has no audio to download", () => {
		renderZone({ ...conversation, has_only_text_chunks: true });
		const button = screen.getByTestId("conversation-download-audio-button");
		expect(button.getAttribute("href")).toBeNull();
		expect(button.getAttribute("data-disabled")).toBe("true");
	});

	it("a recorded conversation links to its audio", () => {
		renderZone();
		const button = screen.getByTestId("conversation-download-audio-button");
		expect(button.getAttribute("href")).toContain("/conversations/c1/content");
	});
});
