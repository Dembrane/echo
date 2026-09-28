// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import { buildMST, findGraphCenter } from "../graph/mst";
import { nodeGeometryKey } from "../graph/nodeSet";
import type { MapGraphNode } from "../types";
import { LayoutClient } from "./client";
import { geometryResultOf } from "./geometryResult";
import { FakeLayoutWorker, fakeWorkerFactory } from "./testWorker";
import { useMapGeometry } from "./useMapGeometry";

const nodes = createSyntheticMap({ count: 30 });

type Props = { nodes: MapGraphNode[]; nodeLimit: number };

const withWorker = (initialProps: Props) => {
	const worker = new FakeLayoutWorker();
	const client = new LayoutClient(fakeWorkerFactory(worker));
	const view = renderHook(
		({ nodes: current, nodeLimit }: Props) =>
			useMapGeometry(current, { client, nodeLimit }),
		{ initialProps },
	);
	const answer = (index: number) =>
		act(() => worker.answer(worker.computes()[index]));
	return { answer, client, view, worker };
};

describe("useMapGeometry", () => {
	it("computes during render where no Worker exists", () => {
		expect(typeof Worker).toBe("undefined");
		const { result } = renderHook(() =>
			useMapGeometry(nodes, { nodeLimit: 150 }),
		);
		expect(result.current.status).toBe("ready");
		expect(result.current.mstEdges).toEqual(buildMST(nodes));
		expect(result.current.centerId).toBe(
			findGraphCenter(nodes, result.current.mstEdges),
		);
		expect(result.current.neighbours.nnLinks).toHaveLength(30 * 10);
		expect(geometryResultOf(result.current.mstEdges)?.key).toBe(
			nodeGeometryKey(nodes),
		);
	});

	it("is idle without nodes", () => {
		const { result } = renderHook(() => useMapGeometry([], { nodeLimit: 150 }));
		expect(result.current).toMatchObject({
			key: null,
			mstEdges: [],
			status: "idle",
		});
	});

	it("goes from computing to ready when the worker answers", () => {
		const { view, worker, answer } = withWorker({ nodeLimit: 150, nodes });
		expect(view.result.current.status).toBe("computing");
		expect(view.result.current.mstEdges).toEqual([]);
		expect(worker.computes()).toHaveLength(1);

		answer(0);
		expect(view.result.current.status).toBe("ready");
		expect(view.result.current.requestId).toBe(worker.computes()[0].requestId);
		expect(view.result.current.mstEdges).toEqual(buildMST(nodes));
	});

	it("refuses over the node budget without asking for a layout, and asks once admitted", () => {
		const { view, worker } = withWorker({ nodeLimit: 29, nodes });
		expect(view.result.current.status).toBe("error");
		expect(view.result.current.error).toContain("30");
		expect(worker.posted).toEqual([]);

		view.rerender({ nodeLimit: 30, nodes });
		expect(view.result.current.status).toBe("computing");
		expect(worker.computes()).toHaveLength(1);
	});

	it("ignores an answer for the node set it had before a filter", () => {
		const { view, worker, answer } = withWorker({ nodeLimit: 150, nodes });
		const filtered = nodes.filter((_, index) => index % 3 !== 0);
		view.rerender({ nodeLimit: 150, nodes: filtered });

		expect(worker.computes()).toHaveLength(2);
		expect(worker.cancels()).toEqual([worker.computes()[0].requestId]);
		answer(0);
		expect(view.result.current.status).toBe("computing");

		answer(1);
		expect(view.result.current.status).toBe("ready");
		expect(view.result.current.mstEdges).toEqual(buildMST(filtered));
		expect(geometryResultOf(view.result.current.mstEdges)?.key).toBe(
			nodeGeometryKey(filtered),
		);
	});

	it("never lets an answer replace the geometry after the budget drops below the node count", () => {
		const { view, answer } = withWorker({ nodeLimit: 150, nodes });
		view.rerender({ nodeLimit: 20, nodes });
		answer(0);
		expect(view.result.current.status).toBe("error");
		expect(view.result.current.mstEdges).toEqual([]);
	});

	it("keeps its result for a refetch with the same ids and vectors, and for a raised budget", () => {
		const { view, worker, answer } = withWorker({ nodeLimit: 150, nodes });
		answer(0);
		const ready = view.result.current;

		view.rerender({
			nodeLimit: 150,
			nodes: nodes.map((node) => ({ ...node })),
		});
		view.rerender({ nodeLimit: 300, nodes });
		expect(worker.computes()).toHaveLength(1);
		expect(view.result.current.status).toBe("ready");
		expect(view.result.current.mstEdges).toBe(ready.mstEdges);
		expect(view.result.current.requestId).toBe(ready.requestId);
	});

	it("does not ask again when only metadata changes", () => {
		const { view, worker, answer } = withWorker({ nodeLimit: 150, nodes });
		answer(0);
		const recoloured = nodes.map((node) => ({
			...node,
			label: `${node.label} (edited)`,
			metadata: { ...node.metadata, sizeScale: 1.5, valence: undefined },
		}));
		view.rerender({ nodeLimit: 150, nodes: recoloured });
		expect(worker.computes()).toHaveLength(1);
		expect(view.result.current.status).toBe("ready");
	});

	it("stops its worker on unmount", () => {
		const { view, worker } = withWorker({ nodeLimit: 150, nodes });
		view.unmount();
		expect(worker.terminated).toBe(true);
		expect(worker.cancels()).toEqual([worker.computes()[0].requestId]);
	});
});
