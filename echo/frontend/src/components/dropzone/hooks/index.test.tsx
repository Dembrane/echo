// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import posthog from "posthog-js";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initiateAndUploadConversationChunk } from "@/lib/api";
import { useUploadConversation } from "./index";

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/components/common/Toaster", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ initiateAndUploadConversationChunk: vi.fn() }));

const upload = vi.mocked(initiateAndUploadConversationChunk);
const capture = vi.mocked(posthog.capture);

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>
		{children}
	</QueryClientProvider>
);

const payload = {
	chunks: [new Blob(["a"]), new Blob(["b"])],
	namePrefix: "",
	pin: "",
	projectId: "project-1",
	tagIdList: [],
	timestamps: [new Date(), new Date()],
};

const runUpload = async () => {
	const { result } = renderHook(() => useUploadConversation(), { wrapper });
	act(() => result.current.mutate(payload));
	await waitFor(() => expect(result.current.isPending).toBe(false));
	return result;
};

describe("useUploadConversation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("captures success when every file uploads", async () => {
		upload.mockResolvedValue([{ id: "c1" }, { id: "c2" }] as unknown as Awaited<
			ReturnType<typeof upload>
		>);

		await runUpload();

		expect(capture).toHaveBeenCalledExactlyOnceWith(
			"conversation_upload_succeeded",
			{ file_count: 2, project_id: "project-1" },
		);
	});

	it("captures failure with the stage when a file fails", async () => {
		upload.mockResolvedValue([
			{ id: "c1" },
			{ error: new Error("S3"), name: "b.mp3", stage: "s3_put" },
		] as unknown as Awaited<ReturnType<typeof upload>>);

		await runUpload();

		expect(capture).toHaveBeenCalledExactlyOnceWith(
			"conversation_upload_failed",
			{
				failed_count: 1,
				file_count: 2,
				project_id: "project-1",
				stage: "s3_put",
			},
		);
	});

	it("captures failure and does not retry when the upload throws", async () => {
		upload.mockRejectedValue(new Error("boom"));

		await runUpload();

		expect(upload).toHaveBeenCalledTimes(1);
		expect(capture).toHaveBeenCalledExactlyOnceWith(
			"conversation_upload_failed",
			{ failed_count: 2, file_count: 2, project_id: "project-1" },
		);
	});
});
