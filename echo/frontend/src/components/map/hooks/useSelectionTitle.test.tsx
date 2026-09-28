// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import { buildMST, centralityOrder } from "../graph/mst";
import {
	createMapInteractionStore,
	MapInteractionProvider,
	type MapInteractionStore,
} from "../state/interactionStore";
import {
	TITLE_DELAY_MS,
	type TitleRequester,
	useSelectionTitle,
} from "./useSelectionTitle";

const nodes = createSyntheticMap({ count: 16 });
const edges = buildMST(nodes);
const ids = (...indexes: number[]) => indexes.map((index) => nodes[index].id);

type Deferred = {
	promise: Promise<{ title: string }>;
	resolve: (value: { title: string }) => void;
	reject: (reason: unknown) => void;
	signal: AbortSignal;
	nodeIds: string[];
};

const deferredRequester = () => {
	const calls: Deferred[] = [];
	const request = vi.fn<TitleRequester>((_resultId, nodeIds, signal) => {
		let resolve!: Deferred["resolve"];
		let reject!: Deferred["reject"];
		const promise = new Promise<{ title: string }>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		calls.push({ nodeIds, promise, reject, resolve, signal });
		return promise;
	});
	return { calls, request };
};

const setup = (request: TitleRequester, enabled = true) => {
	const store = createMapInteractionStore();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MapInteractionProvider store={store}>{children}</MapInteractionProvider>
	);
	const hook = renderHook(
		() =>
			useSelectionTitle({
				edges,
				enabled,
				nodes,
				request,
				resultId: "result-1",
			}),
		{ wrapper },
	);
	return { hook, store };
};

const settle = (
	store: MapInteractionStore,
	nodeIds: string[],
	source: "mst-hover" | "local-hover" = "mst-hover",
) =>
	act(() => {
		store.setHighlightedNodeIds(new Set(nodeIds), {
			isPreview: false,
			source,
		});
	});

const wait = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

const flush = () =>
	act(async () => {
		await Promise.resolve();
	});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useSelectionTitle", () => {
	it("sends one request per settled set after 1.5 s and adds the title to history", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const selection = ids(0, 4, 8, 12);

		settle(store, selection);
		expect(hook.result.current.timerActive).toBe(true);
		await wait(TITLE_DELAY_MS - 1);
		expect(request).not.toHaveBeenCalled();
		await wait(1);
		expect(request).toHaveBeenCalledTimes(1);
		expect(hook.result.current.isProcessing).toBe(true);

		// Same set published again: no second request.
		settle(store, selection);
		await wait(TITLE_DELAY_MS * 2);
		expect(request).toHaveBeenCalledTimes(1);

		await act(async () => {
			calls[0].resolve({ title: "Shared title" });
		});
		const state = hook.result.current;
		expect(state.isProcessing).toBe(false);
		expect(state.history.map((entry) => entry.title)).toEqual(["Shared title"]);
		expect(state.selectedDistillationId).toBe(state.history[0].id);
		expect(store.getState().highlightSource).toBe("history");
		expect(store.getState().highlightedNodeIds).toEqual(new Set(selection));
	});

	it("runs no timer and sends nothing while it is switched off", async () => {
		const { request } = deferredRequester();
		const { hook, store } = setup(request, false);

		settle(store, ids(0, 4, 8, 12));
		expect(hook.result.current.timerActive).toBe(false);
		await wait(TITLE_DELAY_MS * 2);
		expect(request).not.toHaveBeenCalled();
		expect(hook.result.current.isProcessing).toBe(false);
	});

	it("sends every settled id, most central first", async () => {
		const { request } = deferredRequester();
		const { store } = setup(request);
		const selection = ids(15, 14, 13, 3, 2, 1, 0);

		settle(store, selection);
		await wait(TITLE_DELAY_MS);

		const sent = request.mock.calls[0][1];
		expect(sent).toEqual(centralityOrder(selection, nodes, edges));
		expect(new Set(sent)).toEqual(new Set(selection));
	});

	it("starts nothing for preview highlights", async () => {
		const { request } = deferredRequester();
		const { hook, store } = setup(request);

		act(() => {
			store.setHighlightedNodeIds(new Set(ids(0, 1, 2, 3)), {
				isPreview: true,
				source: "local-hover",
			});
		});
		expect(hook.result.current.timerActive).toBe(false);
		await wait(TITLE_DELAY_MS * 3);
		expect(request).not.toHaveBeenCalled();
	});

	it("sends nothing for fewer than three nodes", async () => {
		const { request } = deferredRequester();
		const { store } = setup(request);

		settle(store, ids(0, 1));
		await wait(TITLE_DELAY_MS * 2);
		expect(request).not.toHaveBeenCalled();
	});

	it("discards a late response for a superseded selection", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const first = ids(0, 1, 2, 3, 4);
		const second = ids(8, 9, 10);

		settle(store, first);
		await wait(TITLE_DELAY_MS);
		settle(store, second);
		expect(calls[0].signal.aborted).toBe(true);
		await wait(TITLE_DELAY_MS);
		expect(request).toHaveBeenCalledTimes(2);

		// The first answer lands while the second is pending.
		await act(async () => {
			calls[0].resolve({ title: "Old title" });
		});
		expect(hook.result.current.history).toHaveLength(0);
		expect(hook.result.current.isProcessing).toBe(true);
		expect(store.getState().highlightedNodeIds).toEqual(new Set(second));
		expect(store.getState().highlightSource).toBe("mst-hover");

		await act(async () => {
			calls[1].resolve({ title: "New title" });
		});
		expect(hook.result.current.history.map((entry) => entry.title)).toEqual([
			"New title",
		]);
		expect(hook.result.current.isProcessing).toBe(false);
	});

	it("discards a response once the highlight has moved to a preview", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);

		settle(store, ids(0, 1, 2));
		await wait(TITLE_DELAY_MS);
		act(() => {
			store.setHighlightedNodeIds(new Set(ids(5, 6, 7)), {
				isPreview: true,
				source: "local-hover",
			});
		});
		await act(async () => {
			calls[0].resolve({ title: "Too late" });
		});
		expect(hook.result.current.history).toHaveLength(0);
		expect(store.getState().highlightedNodeIds).toEqual(new Set(ids(5, 6, 7)));
	});

	it("cancels a pending request when the cursor leaves both maps", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);

		settle(store, ids(0, 1, 2));
		await wait(TITLE_DELAY_MS);
		expect(hook.result.current.isProcessing).toBe(true);

		act(() => {
			store.setHighlightedNodeIds(new Set(), { source: "mst-hover" });
		});
		expect(calls[0].signal.aborted).toBe(true);
		expect(hook.result.current.isProcessing).toBe(false);
	});

	it("reuses the title of an identical set without a request", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const first = ids(0, 1, 2, 3);
		const second = ids(10, 11, 12);

		settle(store, first);
		await wait(TITLE_DELAY_MS);
		await act(async () => {
			calls[0].resolve({ title: "First" });
		});
		settle(store, second);
		await wait(TITLE_DELAY_MS);
		await act(async () => {
			calls[1].resolve({ title: "Second" });
		});

		// Back to the first set, in a different order.
		settle(store, [...first].reverse());
		await wait(TITLE_DELAY_MS);
		await flush();

		expect(request).toHaveBeenCalledTimes(2);
		const { history, selectedDistillationId } = hook.result.current;
		expect(history.map((entry) => entry.title)).toEqual(["First", "Second"]);
		expect(selectedDistillationId).toBe(history[0].id);
	});

	it("toggles history without starting a timer", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const selection = ids(0, 1, 2);

		settle(store, selection);
		await wait(TITLE_DELAY_MS);
		await act(async () => {
			calls[0].resolve({ title: "Title" });
		});
		const entryId = hook.result.current.history[0].id;

		act(() => hook.result.current.selectDistillation(entryId));
		expect(hook.result.current.selectedDistillationId).toBeNull();
		expect(store.getState().highlightedNodeIds.size).toBe(0);

		act(() => hook.result.current.selectDistillation(entryId));
		expect(store.getState().highlightSource).toBe("history");
		expect(
			Array.from(store.getState().highlightedNodesDistance.values()),
		).toEqual([0, 0, 0]);
		expect(hook.result.current.timerActive).toBe(false);
		await wait(TITLE_DELAY_MS * 2);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("shows a failure with a retry for the same set", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const selection = ids(0, 1, 2, 3);

		settle(store, selection);
		await wait(TITLE_DELAY_MS);
		await act(async () => {
			calls[0].reject(Object.assign(new Error("bad gateway"), { status: 502 }));
		});
		expect(hook.result.current.error).toMatchObject({ kind: "failed" });
		expect(hook.result.current.isProcessing).toBe(false);

		// Leaving the maps to reach Retry keeps the message.
		act(() => {
			store.setHighlightedNodeIds(new Set(), { source: "mst-hover" });
		});
		expect(hook.result.current.error).not.toBeNull();

		act(() => hook.result.current.retry());
		expect(request).toHaveBeenCalledTimes(2);
		expect(new Set(request.mock.calls[1][1])).toEqual(new Set(selection));
		await act(async () => {
			calls[1].resolve({ title: "Second try" });
		});
		expect(hook.result.current.error).toBeNull();
		expect(hook.result.current.history[0].title).toBe("Second try");
	});

	it("reports a selection that is too large", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);

		settle(store, ids(0, 1, 2, 3, 4, 5));
		await wait(TITLE_DELAY_MS);
		await act(async () => {
			calls[0].reject(Object.assign(new Error("too large"), { status: 413 }));
		});
		expect(hook.result.current.error).toMatchObject({ kind: "too-large" });
	});
});
