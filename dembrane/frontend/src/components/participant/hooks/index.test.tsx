// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	useConfirmConversationChunkUpload,
	useUploadConversationChunk,
} from "./index";

const confirm = vi.fn();
const upload = vi.fn();

vi.mock("posthog-js", () => ({ default: { capture: () => {} } }));
vi.mock("@/components/common/Toaster", () => ({
	toast: { error: () => {}, success: () => {} },
}));
vi.mock("@/lib/api", () => ({
	confirmConversationChunkUpload: (...a: unknown[]) => confirm(...a),
	uploadConversationChunk: (...a: unknown[]) => upload(...a),
}));

const tierLimit = (limit: string) => ({
	message: "Request failed with status code 402",
	response: {
		data: {
			code: "billing.tier_limit",
			detail: {
				error: "FREE_TIER_LIMIT",
				limit,
				upgrade_cta_tier: "changemaker",
			},
			params: { limit },
		},
		status: 402,
	},
});

const serverError = {
	message: "Request failed with status code 500",
	response: { data: { detail: "boom" }, status: 500 },
};

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>
		{children}
	</QueryClientProvider>
);

const chunk = {
	chunk_id: "k1",
	conversationId: "c1",
	file_url: "s3://x",
	source: "PORTAL_AUDIO",
	timestamp: new Date().toISOString(),
};

beforeEach(() => {
	confirm.mockReset();
	upload.mockReset();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("reports a recording stop carried on the confirm response", async () => {
	confirm.mockResolvedValue({ id: "k1", recording_stop: "audio_month" });
	const onRecordingStop = vi.fn();
	const { result } = renderHook(
		() => useConfirmConversationChunkUpload({ onRecordingStop }),
		{ wrapper },
	);
	act(() => result.current.mutate(chunk));
	await waitFor(() =>
		expect(onRecordingStop).toHaveBeenCalledWith("audio_month"),
	);
	expect(onRecordingStop).toHaveBeenCalledTimes(1);
});

it("reports a 402 on confirm once and never retries it", async () => {
	confirm.mockRejectedValue(tierLimit("audio_conversation"));
	const onRecordingStop = vi.fn();
	const { result } = renderHook(
		() => useConfirmConversationChunkUpload({ onRecordingStop }),
		{ wrapper },
	);
	act(() => result.current.mutate(chunk));
	await waitFor(() => expect(result.current.isError).toBe(true));
	expect(onRecordingStop).toHaveBeenCalledTimes(1);
	expect(onRecordingStop).toHaveBeenCalledWith("audio_conversation");
	expect(confirm).toHaveBeenCalledTimes(1);
});

it("a 500 on confirm never opens the wrap modal", async () => {
	vi.useFakeTimers();
	confirm.mockRejectedValue(serverError);
	const onRecordingStop = vi.fn();
	const { result } = renderHook(
		() => useConfirmConversationChunkUpload({ onRecordingStop }),
		{ wrapper },
	);
	act(() => result.current.mutate(chunk));
	await act(() => vi.advanceTimersByTimeAsync(200_000));
	expect(result.current.isError).toBe(true);
	expect(confirm.mock.calls.length).toBeGreaterThan(1);
	expect(onRecordingStop).not.toHaveBeenCalled();
});

it("reports a 402 on the upload URL once and never retries it", async () => {
	upload.mockRejectedValue(tierLimit("audio_month"));
	const onRecordingStop = vi.fn();
	const { result } = renderHook(
		() => useUploadConversationChunk({ onRecordingStop }),
		{ wrapper },
	);
	act(() =>
		result.current.mutate({
			chunk: new Blob(["a"]),
			conversationId: "c1",
			runFinishHook: false,
			source: "PORTAL_AUDIO",
			timestamp: new Date(),
		}),
	);
	await waitFor(() => expect(result.current.isError).toBe(true));
	expect(onRecordingStop).toHaveBeenCalledTimes(1);
	expect(onRecordingStop).toHaveBeenCalledWith("audio_month");
	expect(upload).toHaveBeenCalledTimes(1);
});

it("passes the stop from a confirm that follows an upload", async () => {
	upload.mockResolvedValue(chunk);
	confirm.mockResolvedValue({ id: "k1", recording_stop: "recording_project" });
	const onRecordingStop = vi.fn();
	const { result } = renderHook(
		() => useUploadConversationChunk({ onRecordingStop }),
		{ wrapper },
	);
	act(() =>
		result.current.mutate({
			chunk: new Blob(["a"]),
			conversationId: "c1",
			runFinishHook: false,
			source: "PORTAL_AUDIO",
			timestamp: new Date(),
		}),
	);
	await waitFor(() =>
		expect(onRecordingStop).toHaveBeenCalledWith("recording_project"),
	);
});
