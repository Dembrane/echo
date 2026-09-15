import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMapInteractionStore } from "./interactionStore";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-15T10:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createMapInteractionStore", () => {
	it("starts empty", () => {
		const state = createMapInteractionStore().getState();
		expect(state.selectedNodeId).toBeNull();
		expect(state.highlightedNodeIds.size).toBe(0);
		expect(state.highlightedNodesDistance.size).toBe(0);
		expect(state.highlightSource).toBe("unknown");
		expect(state.highlightIsPreview).toBe(false);
		expect(state.highlightUpdatedAt).toBe(0);
	});

	it("stores a new highlight with its source; the preview flag defaults to false", () => {
		const store = createMapInteractionStore();
		store.setHighlightedNodeIds(new Set(["a", "b"]), { source: "mst-hover" });

		const state = store.getState();
		expect([...state.highlightedNodeIds]).toEqual(["a", "b"]);
		expect(state.highlightSource).toBe("mst-hover");
		expect(state.highlightIsPreview).toBe(false);
		expect(state.highlightUpdatedAt).toBe(Date.now());
	});

	it("updates metadata for the same set with a new source, keeping the set instance", () => {
		const store = createMapInteractionStore();
		store.setHighlightedNodeIds(new Set(["a"]), {
			isPreview: true,
			source: "local-hover",
		});
		const before = store.getState().highlightedNodeIds;
		vi.advanceTimersByTime(1000);

		store.setHighlightedNodeIds(new Set(["a"]), { source: "history" });

		const state = store.getState();
		expect(state.highlightedNodeIds).toBe(before);
		expect(state.highlightSource).toBe("history");
		expect(state.highlightIsPreview).toBe(false);
		expect(state.highlightUpdatedAt).toBe(Date.now());
	});

	it("keeps the source when only the preview flag is given for the same set", () => {
		const store = createMapInteractionStore();
		store.setHighlightedNodeIds(new Set(["a"]), { source: "local-hover" });
		store.setHighlightedNodeIds(new Set(["a"]), { isPreview: true });

		expect(store.getState().highlightSource).toBe("local-hover");
		expect(store.getState().highlightIsPreview).toBe(true);
	});

	it("treats the same set without options as a no-op", () => {
		const store = createMapInteractionStore();
		store.setHighlightedNodeIds(new Set(["a"]), { source: "mst-hover" });
		const before = store.getState();
		const listener = vi.fn();
		store.subscribe(listener);

		store.setHighlightedNodeIds(new Set(["a"]));

		expect(store.getState()).toBe(before);
		expect(listener).not.toHaveBeenCalled();
	});

	it("marks a changed set without options as an unknown, settled highlight", () => {
		const store = createMapInteractionStore();
		store.setHighlightedNodeIds(new Set(["a"]), {
			isPreview: true,
			source: "local-hover",
		});
		store.setHighlightedNodeIds(new Set(["b"]));

		expect(store.getState().highlightSource).toBe("unknown");
		expect(store.getState().highlightIsPreview).toBe(false);
	});

	it("skips distance maps that are equal", () => {
		const store = createMapInteractionStore();
		store.setHighlightedNodesDistance(new Map([["a", 0.5]]));
		const before = store.getState();
		const listener = vi.fn();
		store.subscribe(listener);

		store.setHighlightedNodesDistance(new Map([["a", 0.5]]));
		expect(store.getState()).toBe(before);
		expect(listener).not.toHaveBeenCalled();

		store.setHighlightedNodesDistance(new Map([["a", 0.25]]));
		expect(store.getState().highlightedNodesDistance.get("a")).toBe(0.25);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("notifies on selection changes and stops after unsubscribe", () => {
		const store = createMapInteractionStore();
		const listener = vi.fn();
		const unsubscribe = store.subscribe(listener);

		store.setSelectedNodeId("a");
		expect(store.getState().selectedNodeId).toBe("a");
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		store.setSelectedNodeId("b");
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
