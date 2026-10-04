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

	it("sends nothing, and draws no arc, for fewer than three nodes", async () => {
		const { request } = deferredRequester();
		const { hook, store } = setup(request);

		settle(store, ids(0, 1));
		expect(hook.result.current.timerActive).toBe(false);
		await wait(TITLE_DELAY_MS * 2);
		expect(request).not.toHaveBeenCalled();
	});

	it("cancels the arc when the cursor moves before it is full", async () => {
		const { request } = deferredRequester();
		const { hook, store } = setup(request);

		settle(store, ids(0, 1, 2));
		await wait(TITLE_DELAY_MS / 2);
		settle(store, ids(8, 9));
		expect(hook.result.current.timerActive).toBe(false);
		await wait(TITLE_DELAY_MS * 2);
		expect(request).not.toHaveBeenCalled();
	});

	it("lists a sent request as pending, and keeps it when the cursor leaves", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const selection = ids(0, 1, 2);

		settle(store, selection);
		await wait(TITLE_DELAY_MS);
		expect(hook.result.current.history).toMatchObject([
			{ nodeIds: expect.any(Array), status: "pending" },
		]);

		act(() => {
			store.setHighlightedNodeIds(new Set(), { source: "mst-hover" });
		});
		expect(calls[0].signal.aborted).toBe(false);
		expect(hook.result.current.isProcessing).toBe(true);

		await act(async () => {
			calls[0].resolve({ title: "Landed anyway" });
		});
		const { history, selectedDistillationId } = hook.result.current;
		expect(history).toMatchObject([{ status: "done", title: "Landed anyway" }]);
		expect(selectedDistillationId).toBe(history[0].id);
		expect(store.getState().highlightedNodeIds).toEqual(new Set(selection));
	});

	it("gives Spotlight to the newest request; an older one only fills in history", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const first = ids(0, 1, 2, 3, 4);
		const second = ids(8, 9, 10);

		settle(store, first);
		await wait(TITLE_DELAY_MS);
		settle(store, second);
		await wait(TITLE_DELAY_MS);
		expect(request).toHaveBeenCalledTimes(2);
		expect(calls[0].signal.aborted).toBe(false);

		await act(async () => {
			calls[1].resolve({ title: "New title" });
		});
		const newId = hook.result.current.history[0].id;
		expect(hook.result.current.selectedDistillationId).toBe(newId);

		await act(async () => {
			calls[0].resolve({ title: "Old title" });
		});
		const { history, selectedDistillationId } = hook.result.current;
		expect(history.map((entry) => entry.title)).toEqual([
			"New title",
			"Old title",
		]);
		expect(selectedDistillationId).toBe(newId);
		expect(store.getState().highlightedNodeIds).toEqual(new Set(second));
	});

	it("leaves the map alone when a title lands mid-arc on another set", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const next = ids(8, 9, 10);

		settle(store, ids(0, 1, 2));
		await wait(TITLE_DELAY_MS);
		settle(store, next);
		await wait(TITLE_DELAY_MS / 3);

		await act(async () => {
			calls[0].resolve({ title: "While resting" });
		});
		// Shown in Spotlight, but the arc on the new set keeps running.
		expect(hook.result.current.selectedDistillationId).toBe(
			hook.result.current.history[0].id,
		);
		expect(hook.result.current.timerActive).toBe(true);
		expect(store.getState().highlightedNodeIds).toEqual(new Set(next));
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

	it("marks a failed entry and tries it again", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);
		const selection = ids(0, 1, 2, 3);

		settle(store, selection);
		await wait(TITLE_DELAY_MS);
		await act(async () => {
			calls[0].reject(Object.assign(new Error("bad gateway"), { status: 502 }));
		});
		const entry = hook.result.current.history[0];
		expect(entry.status).toBe("failed");
		expect(hook.result.current.isProcessing).toBe(false);

		act(() => hook.result.current.retry(entry.id));
		expect(request).toHaveBeenCalledTimes(2);
		expect(new Set(request.mock.calls[1][1])).toEqual(new Set(selection));
		await act(async () => {
			calls[1].resolve({ title: "Second try" });
		});
		expect(hook.result.current.history).toMatchObject([
			{ id: entry.id, status: "done", title: "Second try" },
		]);
	});

	it("marks a selection that is too large", async () => {
		const { calls, request } = deferredRequester();
		const { hook, store } = setup(request);

		settle(store, ids(0, 1, 2, 3, 4, 5));
		await wait(TITLE_DELAY_MS);
		await act(async () => {
			calls[0].reject(Object.assign(new Error("too large"), { status: 413 }));
		});
		expect(hook.result.current.history[0].status).toBe("too-large");
	});

	it("cancels what is in flight when the result changes", async () => {
		const { calls, request } = deferredRequester();
		const store = createMapInteractionStore();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<MapInteractionProvider store={store}>{children}</MapInteractionProvider>
		);
		const hook = renderHook(
			({ resultId }: { resultId: string }) =>
				useSelectionTitle({ edges, nodes, request, resultId }),
			{ initialProps: { resultId: "result-1" }, wrapper },
		);

		settle(store, ids(0, 1, 2));
		await wait(TITLE_DELAY_MS);
		hook.rerender({ resultId: "result-2" });
		expect(calls[0].signal.aborted).toBe(true);
		expect(hook.result.current.history).toEqual([]);
	});
});
