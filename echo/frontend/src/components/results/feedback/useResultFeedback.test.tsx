// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AnalysisObject,
	type AnalysisObjectsPage,
	analysisKeys,
} from "@/components/analysis/hooks";
import { bff } from "@/lib/bff";
import { useResultFeedback } from "./useResultFeedback";

vi.mock("@/lib/bff", () => ({ bff: { delete: vi.fn(), put: vi.fn() } }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

const PROJECT = "project-1";
const KEY = analysisKeys.objects(PROJECT, "popcorn", "active", 0);

const item = (over: Partial<AnalysisObject> = {}): AnalysisObject => ({
	objectId: "obj-1",
	revisionId: "rev-1",
	type: "popcorn",
	...over,
});

const page = (items: AnalysisObject[]): AnalysisObjectsPage => ({
	canEdit: true,
	counts: { popcorn: items.length },
	items,
	limit: 50,
	offset: 0,
	snapshotId: "snap-1",
	total: items.length,
});

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const setUp = () =>
	renderHook(() => useResultFeedback(PROJECT), { wrapper }).result;

beforeEach(() => {
	client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	client.setQueryData(KEY, page([item(), item({ objectId: "obj-2" })]));
	vi.mocked(bff.put).mockResolvedValue({
		myFeedback: {
			rating: "up",
			revisionId: "rev-1",
			tags: ["recognizable"],
		},
	});
	vi.mocked(bff.delete).mockResolvedValue({ myFeedback: null });
});

afterEach(() => vi.clearAllMocks());

describe("a host's thumb on a finding", () => {
	it("counts at once and sends the wording it was about", async () => {
		const feedback = setUp();
		expect(feedback.current.feedbackFor(item())).toBeNull();

		act(() =>
			feedback.current.rate("obj-1", "rev-1", {
				rating: "up",
				tags: ["recognizable"],
			}),
		);
		// Before the request has answered, the row already reads "up".
		expect(feedback.current.feedbackFor(item())?.rating).toBe("up");
		await waitFor(() => expect(vi.mocked(bff.put)).toHaveBeenCalled());
		expect(vi.mocked(bff.put).mock.calls[0][0]).toBe(
			`/analysis/projects/${PROJECT}/objects/obj-1/feedback`,
		);
		expect(vi.mocked(bff.put).mock.calls[0][1]).toEqual({
			note: undefined,
			rating: "up",
			revision_id: "rev-1",
			tags: ["recognizable"],
		});

		// The cached page is patched rather than thrown away: one thumb does not
		// cost the whole list.
		await waitFor(() =>
			expect(
				client.getQueryData<AnalysisObjectsPage>(KEY)?.items[0].myFeedback
					?.rating,
			).toBe("up"),
		);
		expect(
			client.getQueryData<AnalysisObjectsPage>(KEY)?.items[1].myFeedback,
		).toBeUndefined();
	});

	it("overwrites up with down rather than keeping both", async () => {
		const feedback = setUp();
		act(() =>
			feedback.current.rate("obj-1", "rev-1", { rating: "up", tags: [] }),
		);
		await waitFor(() => expect(vi.mocked(bff.put)).toHaveBeenCalledTimes(1));

		vi.mocked(bff.put).mockResolvedValue({
			myFeedback: { rating: "down", revisionId: "rev-1", tags: ["tone_deaf"] },
		});
		act(() =>
			feedback.current.rate("obj-1", "rev-1", {
				rating: "down",
				tags: ["tone_deaf"],
			}),
		);
		expect(feedback.current.feedbackFor(item())?.rating).toBe("down");
		await waitFor(() =>
			expect(
				client.getQueryData<AnalysisObjectsPage>(KEY)?.items[0].myFeedback
					?.rating,
			).toBe("down"),
		);
	});

	it("clears with a delete and leaves nothing behind", async () => {
		const feedback = setUp();
		const rated = item({
			myFeedback: { rating: "up", revisionId: "rev-1", tags: [] },
		});
		expect(feedback.current.feedbackFor(rated)?.rating).toBe("up");

		act(() => feedback.current.rate("obj-1", "rev-1", null));
		expect(feedback.current.feedbackFor(rated)).toBeNull();
		await waitFor(() =>
			expect(vi.mocked(bff.delete)).toHaveBeenCalledWith(
				`/analysis/projects/${PROJECT}/objects/obj-1/feedback`,
			),
		);
		await waitFor(() =>
			expect(
				client.getQueryData<AnalysisObjectsPage>(KEY)?.items[0].myFeedback,
			).toBeNull(),
		);
	});

	it("falls back to what the server last said when the write fails", async () => {
		vi.mocked(bff.put).mockRejectedValue(
			Object.assign(new Error("nope"), { status: 503 }),
		);
		const feedback = setUp();
		const rated = item({
			myFeedback: { rating: "up", revisionId: "rev-1", tags: [] },
		});

		act(() =>
			feedback.current.rate("obj-1", "rev-1", { rating: "down", tags: [] }),
		);
		expect(feedback.current.feedbackFor(rated)?.rating).toBe("down");

		// No toast, the same convention as the other result actions: the overlay
		// falls away and the row shows the thumb the server holds.
		await waitFor(() =>
			expect(feedback.current.feedbackFor(rated)?.rating).toBe("up"),
		);
		expect(
			client.getQueryData<AnalysisObjectsPage>(KEY)?.items[0].myFeedback,
		).toBeUndefined();
	});
});
