// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, expect, it, vi } from "vitest";
import {
	initiateAndUploadConversationChunk,
	UploadFailedError,
} from "@/lib/api";
import { useConversationUploader, useUploadConversation } from "./index";

vi.mock("@/lib/api", () => ({
	initiateAndUploadConversationChunk: vi.fn(async () => ({})),
	UploadFailedError: class UploadFailedError extends Error {
		failed: { name: string; error: Error }[];
		constructor(failed: { name: string; error: Error }[]) {
			super("failed");
			this.failed = failed;
		}
	},
}));
vi.mock("@/components/common/Toaster", () => ({
	toast: { success: vi.fn() },
}));
vi.mock("@/components/error/notifyError", () => ({ notifyError: vi.fn() }));

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
});

const payload = {
	chunks: [],
	namePrefix: "",
	pin: "",
	projectId: "p1",
	tagIdList: [],
	timestamps: [],
};

it("an upload refreshes the conversation counts on the organisation overview", async () => {
	const qc = new QueryClient();
	const keys = [
		["v2", "workspaces"],
		["v2", "workspace-usage", "w1", 0],
		["v2", "org-usage", "o1", 0],
	];
	for (const k of keys) qc.setQueryData(k, {});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useUploadConversation(), { wrapper });
	await act(() =>
		result.current.mutateAsync({
			chunks: [],
			namePrefix: "",
			pin: "",
			projectId: "p1",
			tagIdList: [],
			timestamps: [],
		}),
	);
	for (const k of keys) expect(qc.getQueryState(k)?.isInvalidated).toBe(true);
});

const freeKeys = [
	["workspace", "w1", "free-allowance"],
	["project", "p1", "recording"],
	["project", "p2", "recording"],
];

it.each([
	["succeeds", false],
	["fails", true],
])(
	"an upload that %s refreshes the free allowance and recording status",
	async (_, fails) => {
		if (fails)
			vi.mocked(initiateAndUploadConversationChunk).mockRejectedValueOnce(
				new Error("boom"),
			);
		const qc = new QueryClient();
		for (const k of freeKeys) qc.setQueryData(k, {});
		qc.setQueryData(["project", "p1", "other"], {});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useUploadConversation(), { wrapper });
		await act(() => result.current.mutateAsync(payload).catch(() => null));
		for (const k of freeKeys)
			expect(qc.getQueryState(k)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["project", "p1", "other"])?.isInvalidated).toBe(
			false,
		);
	},
);

it("a file refused for a free limit shows the refusal in its error", async () => {
	const refusal = Object.assign(new Error("HTTP 402"), {
		response: {
			data: {
				code: "billing.tier_limit",
				detail: {
					error: "FREE_TIER_LIMIT",
					file_seconds: 3600,
					limit: "audio_month",
					remaining_seconds: 1800,
					upgrade_cta_tier: "changemaker",
				},
				params: { limit: "audio_month" },
			},
			status: 402,
		},
	});
	vi.mocked(initiateAndUploadConversationChunk).mockRejectedValueOnce(
		new UploadFailedError(
			[
				{ error: refusal, name: "a.mp3" },
				{ error: new Error("network down"), name: "b.mp3" },
			],
			0,
		),
	);
	const qc = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useConversationUploader(), { wrapper });
	act(() =>
		result.current.uploadFiles({
			...payload,
			chunks: [
				new File(["x"], "a.mp3", { type: "audio/mpeg" }),
				new File(["x"], "b.mp3", { type: "audio/mpeg" }),
			],
		}),
	);
	await waitFor(() =>
		expect(result.current.uploadErrors["a.mp3"]).toMatch(
			/You have 30 min of recording left this month/,
		),
	);
	expect(result.current.uploadErrors["b.mp3"]).not.toBe("network down");
});

it("a file the server cannot read shows the catalog message, not the raw error", async () => {
	const unreadable = Object.assign(
		new Error("Request failed with status code 422"),
		{
			response: {
				data: {
					action: "fix_input",
					code: "upload.unreadable",
					detail: "This file could not be read as audio",
					params: {},
				},
				status: 422,
			},
		},
	);
	vi.mocked(initiateAndUploadConversationChunk).mockRejectedValueOnce(
		new UploadFailedError([{ error: unreadable, name: "a.mp3" }], 0),
	);
	const qc = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useConversationUploader(), { wrapper });
	act(() =>
		result.current.uploadFiles({
			...payload,
			chunks: [new File(["x"], "a.mp3", { type: "audio/mpeg" })],
		}),
	);
	await waitFor(() =>
		expect(result.current.uploadErrors["a.mp3"]).toBe(
			"This file could not be read as audio. Choose another file.",
		),
		// The error messages load as their own chunk.
		{ timeout: 10_000 },
	);
});
