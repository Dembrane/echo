import { describe, expect, it, vi } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import { buildMST } from "../graph/mst";
import { packVectors } from "./compute";
import type { LayoutComputeMessage, LayoutWorkerResponse } from "./protocol";
import { createLayoutWorkerHandler } from "./runner";

const nodes = createSyntheticMap({ count: 40 });

const compute = (
	requestId: number,
	source = nodes,
	nodeLimit = 150,
): LayoutComputeMessage => ({
	...packVectors(source),
	nodeLimit,
	requestId,
	type: "compute",
});

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A handler that yields after every step, so every step is a cancellation point. */
const handlerWithPosts = () => {
	const posts: LayoutWorkerResponse[] = [];
	const handle = createLayoutWorkerHandler(
		(response) => posts.push(response),
		nextTask,
		0,
	);
	return { handle, posts };
};

describe("layout worker handler", () => {
	it("answers a compute with the tree", async () => {
		const { handle, posts } = handlerWithPosts();
		await handle(compute(1));
		expect(posts).toHaveLength(1);
		const [response] = posts;
		expect(response.type).toBe("result");
		if (response.type !== "result") return;
		expect(response.requestId).toBe(1);
		expect(response.result.mstEdges).toEqual(buildMST(nodes));
	});

	it("drops a running request when a newer one arrives", async () => {
		const { handle, posts } = handlerWithPosts();
		const older = handle(compute(1));
		const newer = handle(compute(2, nodes.slice(5)));
		await Promise.all([older, newer]);

		expect(posts.map((post) => post.requestId)).toEqual([2]);
		const [response] = posts;
		if (response.type !== "result") throw new Error("expected a result");
		expect(response.result.mstEdges).toEqual(buildMST(nodes.slice(5)));
	});

	it("stops a cancelled request and posts nothing for it", async () => {
		const { handle, posts } = handlerWithPosts();
		const running = handle(compute(1));
		await handle({ requestId: 1, type: "cancel" });
		await running;
		expect(posts).toEqual([]);
	});

	it("refuses over the node budget with an over-budget error", async () => {
		const { handle, posts } = handlerWithPosts();
		const yieldSpy = vi.fn(nextTask);
		const refusing = createLayoutWorkerHandler(
			(response) => posts.push(response),
			yieldSpy,
			0,
		);
		await refusing(compute(3, nodes, 39));
		expect(posts).toEqual([
			expect.objectContaining({
				code: "over-budget",
				requestId: 3,
				type: "error",
			}),
		]);
		// Refused before the first step: it never paused
		expect(yieldSpy).not.toHaveBeenCalled();
		await handle(compute(4));
		expect(posts.at(-1)?.type).toBe("result");
	});

	it("answers a failure with a failed error instead of throwing", async () => {
		const { handle, posts } = handlerWithPosts();
		await handle({
			...compute(5),
			vectors: null as unknown as Float64Array,
		});
		expect(posts).toEqual([
			expect.objectContaining({ code: "failed", requestId: 5, type: "error" }),
		]);
	});
});
