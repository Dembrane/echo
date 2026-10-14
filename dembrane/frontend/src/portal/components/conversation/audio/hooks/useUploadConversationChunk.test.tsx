// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isConversationGone,
	useUploadConversationChunk,
} from "./useUploadConversationChunk";

const upload = vi.fn();
const confirm = vi.fn();
const capture = vi.fn();

vi.mock("@/lib/api", () => ({
	confirmConversationChunkUpload: (...args: unknown[]) => confirm(...args),
	uploadConversationChunk: (...args: unknown[]) => upload(...args),
}));

vi.mock("posthog-js", () => ({
	default: { capture: (...args: unknown[]) => capture(...args) },
}));

const httpError = (status: number) =>
	Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status },
	});

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>
		{children}
	</QueryClientProvider>
);

const variables = {
	chunk: new Blob(["audio"]),
	conversationId: "c1",
	source: "PORTAL_AUDIO",
	timestamp: new Date(),
};

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("useUploadConversationChunk", () => {
	it.each([404, 403, 410])(
		"says the conversation is gone when the upload URL request gets %i, without retrying",
		async (status) => {
			upload.mockRejectedValue(httpError(status));
			const onConversationGone = vi.fn();
			const { result } = renderHook(
				() => useUploadConversationChunk({ onConversationGone }),
				{ wrapper },
			);

			await expect(result.current.mutateAsync(variables)).rejects.toThrow();

			expect(onConversationGone).toHaveBeenCalledTimes(1);
			expect(upload).toHaveBeenCalledTimes(1);
		},
	);

	it("says the conversation is gone when the confirm gets a 404", async () => {
		upload.mockResolvedValue({ chunk_id: "k1", conversationId: "c1" });
		confirm.mockRejectedValue(httpError(404));
		const onConversationGone = vi.fn();
		const { result } = renderHook(
			() => useUploadConversationChunk({ onConversationGone }),
			{ wrapper },
		);

		await result.current.mutateAsync(variables);

		await waitFor(() => expect(onConversationGone).toHaveBeenCalledTimes(1));
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});

describe("isConversationGone", () => {
	it.each([404, 403, 410])("is true for %i", (status) => {
		expect(isConversationGone(httpError(status))).toBe(true);
	});

	it("is false for other statuses and for errors with no response", () => {
		expect(isConversationGone(httpError(500))).toBe(false);
		expect(isConversationGone(new Error("Failed to upload file to S3"))).toBe(
			false,
		);
		expect(isConversationGone(null)).toBe(false);
	});
});
