import { describe, expect, it } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import { buildMST } from "../graph/mst";
import { nodeGeometryKey } from "../graph/nodeSet";
import {
	LayoutClient,
	type LayoutRequest,
	type LayoutWorkerFactory,
} from "./client";
import { geometryResultOf } from "./geometryResult";
import {
	FakeLayoutWorker as FakeWorker,
	fakeWorkerFactory as factoryFor,
} from "./testWorker";

const unavailable: LayoutWorkerFactory = {
	available: () => false,
	create: () => {
		throw new Error("no worker here");
	},
};

const nodes = createSyntheticMap({ count: 30 });

const requestFor = (source = nodes, nodeLimit = 150): LayoutRequest => {
	const geometryKey = nodeGeometryKey(source);
	return { geometryKey, key: `v1|${geometryKey}`, nodeLimit, nodes: source };
};

describe("LayoutClient", () => {
	it("posts one compute and is ready when its answer arrives", () => {
		const worker = new FakeWorker();
		const client = new LayoutClient(factoryFor(worker));
		const request = requestFor();

		const requestId = client.request(request);
		expect(client.getSnapshot()).toMatchObject({
			pendingKey: request.key,
			ready: null,
			requestId,
		});
		expect(worker.computes()).toHaveLength(1);

		worker.answer(worker.computes()[0]);
		const { ready, pendingKey } = client.getSnapshot();
		expect(pendingKey).toBeNull();
		expect(ready?.requestId).toBe(requestId);
		expect(ready?.geometry.mstEdges).toEqual(buildMST(nodes));
		expect(geometryResultOf(ready?.geometry.mstEdges)?.key).toBe(
			request.geometryKey,
		);
	});

	it("supersedes an older request: cancels it and ignores its late answer", () => {
		const worker = new FakeWorker();
		const client = new LayoutClient(factoryFor(worker));
		const first = client.request(requestFor());
		const filtered = nodes.slice(4);
		const second = client.request(requestFor(filtered));

		expect(second).toBeGreaterThan(first);
		expect(worker.cancels()).toEqual([first]);

		const [olderMessage, newerMessage] = worker.computes();
		worker.answer(olderMessage);
		expect(client.getSnapshot().ready).toBeNull();
		expect(client.getSnapshot().pendingKey).toBe(requestFor(filtered).key);

		worker.answer(newerMessage);
		expect(client.getSnapshot().ready?.requestId).toBe(second);
		expect(client.getSnapshot().ready?.geometry.mstEdges).toEqual(
			buildMST(filtered),
		);

		// A duplicate of the older answer after the newer one changes nothing
		worker.answer(olderMessage);
		expect(client.getSnapshot().ready?.requestId).toBe(second);
	});

	it("ignores an answer that arrives after a cancel", () => {
		const worker = new FakeWorker();
		const client = new LayoutClient(factoryFor(worker));
		const requestId = client.request(requestFor());
		client.cancel(requestId);
		worker.answer(worker.computes()[0]);
		expect(client.getSnapshot()).toMatchObject({
			pendingKey: null,
			ready: null,
		});
	});

	it("refuses over the node budget without packing or posting anything", () => {
		const worker = new FakeWorker();
		const client = new LayoutClient(factoryFor(worker));
		const request = requestFor(nodes, 29);
		client.request(request);

		expect(worker.posted).toEqual([]);
		expect(client.getSnapshot().error).toMatchObject({
			code: "over-budget",
			key: request.key,
		});
	});

	it("reuses a ready result for the same key", () => {
		const worker = new FakeWorker();
		const client = new LayoutClient(factoryFor(worker));
		const first = client.request(requestFor());
		worker.answer(worker.computes()[0]);

		// The same nodes again, as a refetch or a raised budget would ask
		const again = client.request(
			requestFor(nodes.map((node) => ({ ...node }))),
		);
		expect(again).toBe(first);
		expect(worker.computes()).toHaveLength(1);
	});

	it("keeps a pending request for the same key instead of starting another", () => {
		const worker = new FakeWorker();
		const client = new LayoutClient(factoryFor(worker));
		const first = client.request(requestFor());
		expect(client.request(requestFor())).toBe(first);
		expect(worker.computes()).toHaveLength(1);
		expect(worker.cancels()).toEqual([]);
	});

	it("computes synchronously where no worker is available", () => {
		const client = new LayoutClient(unavailable);
		expect(client.usesWorker()).toBe(false);
		client.request(requestFor());
		expect(client.getSnapshot().ready?.geometry.mstEdges).toEqual(
			buildMST(nodes),
		);
	});

	it("finishes the pending request synchronously when the worker fails", () => {
		const worker = new FakeWorker();
		const client = new LayoutClient(factoryFor(worker));
		client.request(requestFor());
		worker.onerror?.({ message: "failed to load" });

		expect(worker.terminated).toBe(true);
		expect(client.usesWorker()).toBe(false);
		expect(client.getSnapshot().ready?.geometry.mstEdges).toEqual(
			buildMST(nodes),
		);
	});

	it("notifies subscribers of every change", () => {
		const worker = new FakeWorker();
		const client = new LayoutClient(factoryFor(worker));
		let notified = 0;
		const unsubscribe = client.subscribe(() => {
			notified++;
		});
		client.request(requestFor());
		worker.answer(worker.computes()[0]);
		unsubscribe();
		client.request(requestFor(nodes.slice(1)));
		expect(notified).toBe(2);
	});
});
