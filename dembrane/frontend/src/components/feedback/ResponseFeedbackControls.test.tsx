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
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const setMutate = vi.fn();
const clearMutate = vi.fn();
const pendingState = { value: false };
vi.mock("./hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("./hooks")>()),
	useClearResponseFeedbackMutation: () => ({
		isPending: false,
		mutate: clearMutate,
	}),
	useSetResponseFeedbackMutation: () => ({
		isPending: pendingState.value,
		mutate: setMutate,
	}),
}));
const toastSuccess = vi.fn();
vi.mock("@/components/common/Toaster", () => ({
	toast: {
		error: vi.fn(),
		success: (...args: unknown[]) => toastSuccess(...args),
	},
}));
const captureMock = vi.fn();
vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => captureMock(...args),
		get_session_replay_url: () => "https://eu.posthog.com/replay/x",
	},
}));

import { ResponseFeedbackControls } from "./ResponseFeedbackControls";

const wrap = (ui: React.ReactElement) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					{ui}
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
	toastSuccess.mockClear();
	captureMock.mockClear();
});

describe("ResponseFeedbackControls", () => {
	it("thumbs up records silently", () => {
		wrap(<ResponseFeedbackControls targetType="chat_message" targetId="m-1" />);
		fireEvent.click(screen.getByTestId("response-feedback-up"));
		expect(setMutate).toHaveBeenCalledWith(
			expect.objectContaining({ rating: "up", targetId: "m-1" }),
			expect.anything(),
		);
		expect(screen.queryByText("What went wrong?")).toBeNull();
	});

	it("thumbs down records then opens the modal; selected reasons fill, send includes reasons and comment", async () => {
		wrap(<ResponseFeedbackControls targetType="chat_message" targetId="m-1" />);
		fireEvent.click(screen.getByTestId("response-feedback-down"));
		// Nothing is sent until the host sends or dismisses; the thumb fills at once.
		expect(setMutate).not.toHaveBeenCalled();
		expect(
			screen.getByTestId("response-feedback-down").getAttribute("aria-pressed"),
		).toBe("true");
		await waitFor(() =>
			expect(screen.getByTestId("response-feedback-modal")).toBeTruthy(),
		);
		expect(await screen.findByText("What went wrong?")).toBeTruthy();
		const sendButton = (await screen.findByTestId(
			"response-feedback-send",
		)) as HTMLButtonElement;
		expect(sendButton.disabled).toBe(true);
		const reason = await screen.findByTestId(
			"response-feedback-reason-incorrect",
		);
		expect(reason.getAttribute("data-variant")).toBe("outline");
		expect(reason.style.borderRadius).toBe("var(--mantine-radius-full)");
		fireEvent.click(reason);
		expect(reason.getAttribute("aria-pressed")).toBe("true");
		expect(reason.getAttribute("data-variant")).toBe("filled");
		expect(sendButton.disabled).toBe(false);
		// Single select: picking another reason replaces the first.
		const other = screen.getByTestId("response-feedback-reason-wrong_sources");
		fireEvent.click(other);
		expect(other.getAttribute("aria-pressed")).toBe("true");
		expect(reason.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(reason);
		fireEvent.change(await screen.findByTestId("response-feedback-comment"), {
			target: { value: "The dates are off" },
		});
		fireEvent.click(screen.getByTestId("response-feedback-send"));
		expect(setMutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				comment: "The dates are off",
				rating: "down",
				reasons: ["incorrect"],
			}),
			expect.anything(),
		);
	});

	it("send shows a toast once the mutation succeeds", async () => {
		setMutate.mockImplementation(
			(_input: unknown, opts?: { onSuccess?: () => void }) =>
				opts?.onSuccess?.(),
		);
		wrap(<ResponseFeedbackControls targetType="chat_message" targetId="m-1" />);
		fireEvent.click(screen.getByTestId("response-feedback-down"));
		expect(setMutate).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		fireEvent.change(await screen.findByTestId("response-feedback-comment"), {
			target: { value: "Missed my point" },
		});
		fireEvent.click(await screen.findByTestId("response-feedback-send"));
		expect(toastSuccess).toHaveBeenCalledWith("Feedback sent");
		// One PUT, one analytics event carrying the details.
		expect(setMutate).toHaveBeenCalledTimes(1);
		expect(captureMock).toHaveBeenCalledTimes(1);
		expect(captureMock).toHaveBeenCalledWith(
			"response_feedback_submitted",
			expect.objectContaining({ has_comment: true, rating: "down" }),
		);
		setMutate.mockReset();
	});

	it("cancel closes the modal and saves the bare downvote once", async () => {
		setMutate.mockImplementation(
			(_input: unknown, opts?: { onSuccess?: () => void }) =>
				opts?.onSuccess?.(),
		);
		wrap(<ResponseFeedbackControls targetType="chat_message" targetId="m-1" />);
		fireEvent.click(screen.getByTestId("response-feedback-down"));
		await waitFor(() =>
			expect(screen.getByTestId("response-feedback-modal")).toBeTruthy(),
		);
		fireEvent.click(
			await screen.findByTestId("response-feedback-modal-cancel"),
		);
		expect(setMutate).toHaveBeenCalledTimes(1);
		expect(setMutate).toHaveBeenCalledWith(
			expect.objectContaining({ rating: "down", reasons: [] }),
			expect.anything(),
		);
		expect(clearMutate).not.toHaveBeenCalled();
		// Dismissing counts the plain downvote exactly once.
		expect(captureMock).toHaveBeenCalledTimes(1);
		expect(captureMock).toHaveBeenCalledWith(
			"response_feedback_submitted",
			expect.objectContaining({ rating: "down", reasons: [] }),
		);
		setMutate.mockReset();
	});

	it("clicking the active thumb clears", () => {
		wrap(
			<ResponseFeedbackControls
				targetType="chat_message"
				targetId="m-1"
				current={{
					comment: null,
					date_created: null,
					id: "fb-1",
					rating: "up",
					reasons: [],
					target_id: "m-1",
					target_type: "chat_message",
				}}
			/>,
		);
		fireEvent.click(screen.getByTestId("response-feedback-up"));
		expect(clearMutate).toHaveBeenCalledWith(
			expect.objectContaining({ targetId: "m-1" }),
			expect.anything(),
		);
		expect(setMutate).not.toHaveBeenCalled();
	});

	it("thumbs are disabled while a vote is in flight", () => {
		pendingState.value = true;
		try {
			wrap(
				<ResponseFeedbackControls targetType="chat_message" targetId="m-1" />,
			);
			expect(
				(screen.getByTestId("response-feedback-down") as HTMLButtonElement)
					.disabled,
			).toBe(true);
		} finally {
			pendingState.value = false;
		}
	});

	it("disabled hides interaction", () => {
		wrap(
			<ResponseFeedbackControls
				targetType="chat_message"
				targetId="m-1"
				disabled
			/>,
		);
		expect(
			(screen.getByTestId("response-feedback-up") as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
});
