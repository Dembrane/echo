// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/bff";
import { RESULTS_PAGE, useResultsList, useResultsVisit } from "./index";

vi.mock("@/lib/bff", () => ({
	bff: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const counts = {
	argument: 0,
	deduplicated_argument: 0,
	popcorn: 140,
	stakeholder: 0,
	tension: 0,
};

/** A page of popcorn, as long as the server would send it. */
const page = (offset: number, length: number) => ({
	canEdit: true,
	counts,
	items: Array.from({ length }, (_, index) => ({
		objectId: `pop-${offset + index}`,
		revisionId: `rev-${offset + index}`,
		type: "popcorn",
	})),
	limit: RESULTS_PAGE,
	offset,
	snapshotId: "snap-1",
	total: counts.popcorn,
});

const params = () =>
	vi
		.mocked(bff.get)
		.mock.calls.map(([, query]) => query as Record<string, unknown>);

beforeEach(() => {
	vi.mocked(bff.get).mockImplementation(async (path: string, query) => {
		if (path.endsWith("/results/last-opened")) return { openedAt: null };
		const { offset = 0, type } = (query ?? {}) as {
			offset?: number;
			type?: string;
		};
		if (type !== "popcorn") return page(0, 0);
		return page(offset, Math.min(RESULTS_PAGE, counts.popcorn - offset));
	});
	vi.mocked(bff.put).mockResolvedValue({ openedAt: "2026-09-20T10:00:00Z" });
});

afterEach(() => vi.clearAllMocks());

describe("the results list", () => {
	it("asks each kind for its first page, sorted by what needs an eye", async () => {
		const list = renderHook(() => useResultsList("project-1"), { wrapper });
		await waitFor(() => expect(list.result.current.items).toHaveLength(50));
		expect(params().every((query) => query.sort === "attention")).toBe(true);
		expect(params().map((query) => query.type)).toEqual([
			"popcorn",
			"tension",
			"stakeholder",
			"argument",
			"deduplicated_argument",
		]);
		// The counts are the whole list's; the page is only what came back.
		expect(list.result.current.counts.popcorn).toBe(140);
		expect(list.result.current.total).toBe(140);
		expect(list.result.current.canEdit).toBe(true);
	});

	it("stacks the next page of one kind on the one before it", async () => {
		const list = renderHook(() => useResultsList("project-1"), { wrapper });
		await waitFor(() => expect(list.result.current.items).toHaveLength(50));

		act(() => list.result.current.loadMore(["popcorn"]));
		await waitFor(() => expect(list.result.current.items).toHaveLength(100));
		expect(
			params().some(
				(query) => query.type === "popcorn" && query.offset === RESULTS_PAGE,
			),
		).toBe(true);
		// In the order the server gave them, so nothing moves under the host.
		expect(list.result.current.items[50]?.objectId).toBe("pop-50");

		act(() => list.result.current.loadMore(["popcorn"]));
		await waitFor(() => expect(list.result.current.items).toHaveLength(140));
	});

	it("asks nothing more of a kind that has answered in full", async () => {
		const list = renderHook(() => useResultsList("project-1"), { wrapper });
		await waitFor(() => expect(list.result.current.items).toHaveLength(50));
		act(() => list.result.current.loadMore(["tension"]));
		act(() => list.result.current.loadMore(["popcorn", "popcorn"]));
		await waitFor(() => expect(list.result.current.items).toHaveLength(100));
		const asked = params().filter((query) => query.type === "popcorn");
		expect(asked).toHaveLength(2);
		expect(params().filter((query) => query.type === "tension")).toHaveLength(
			1,
		);
	});

	it("keeps to one kind where the host filtered for one", async () => {
		const list = renderHook(
			() => useResultsList("project-1", { type: "popcorn" }),
			{ wrapper },
		);
		await waitFor(() => expect(list.result.current.items).toHaveLength(50));
		expect(params()).toHaveLength(1);
		expect(list.result.current.total).toBe(140);
	});
});

describe("a visit to the list", () => {
	it("reads when this host last opened it, and marks it once on the way out", async () => {
		const visit = renderHook(() => useResultsVisit("project-1"), { wrapper });
		await waitFor(() =>
			expect(
				vi
					.mocked(bff.get)
					.mock.calls.some(([path]) => path.endsWith("/results/last-opened")),
			).toBe(true),
		);
		// Nothing is written while the host is reading: what is new stays new.
		expect(bff.put).not.toHaveBeenCalled();

		visit.unmount();
		expect(bff.put).toHaveBeenCalledTimes(1);
		expect(vi.mocked(bff.put).mock.calls[0][0]).toBe(
			"/analysis/projects/project-1/results/last-opened",
		);
	});
});
