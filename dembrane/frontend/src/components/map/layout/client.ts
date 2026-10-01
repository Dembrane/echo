/**
 * Main-thread side of the layout worker: one pending request at a time, a
 * newer request supersedes (and cancels) the older one, and responses for
 * any other request id are ignored. Where no Worker exists (tests, jsdom) or
 * the worker fails to load, the same computation runs synchronously.
 *
 * An external store for useSyncExternalStore: subscribe and getSnapshot.
 */
import {
	isValidNodeLimit,
	type LayoutOutput,
	overBudgetMessage,
	packVectors,
	runLayoutSync,
} from "./compute";
import { type GeometryResult, registerGeometryResult } from "./geometryResult";
import type {
	LayoutErrorCode,
	LayoutWorkerRequest,
	LayoutWorkerResponse,
} from "./protocol";

export type LayoutWorkerLike = {
	postMessage: (
		message: LayoutWorkerRequest,
		transfer?: Transferable[],
	) => void;
	terminate: () => void;
	onmessage: ((event: { data: LayoutWorkerResponse }) => void) | null;
	onerror: ((event: { message?: string }) => void) | null;
};

export type LayoutWorkerFactory = {
	/** Whether a worker can be created here, checked without creating one. */
	available: () => boolean;
	create: () => LayoutWorkerLike;
};

export const browserLayoutWorkerFactory: LayoutWorkerFactory = {
	available: () => typeof Worker !== "undefined",
	create: () =>
		new Worker(new URL("./layout.worker.ts", import.meta.url), {
			type: "module",
		}) as unknown as LayoutWorkerLike,
};

export type LayoutRequest = {
	/** Request key: algorithm version plus the node set's geometry key. */
	key: string;
	/** nodeGeometryKey of `nodes`, stored on the result for the renderers. */
	geometryKey: string;
	nodes: ReadonlyArray<{ id: string; embedding: ReadonlyArray<number> }>;
	nodeLimit: number;
	seed?: number;
};

export type LayoutReady = {
	requestId: number;
	key: string;
	geometry: GeometryResult;
	result: LayoutOutput;
};

export type LayoutFailure = {
	requestId: number;
	key: string;
	code: LayoutErrorCode;
	message: string;
};

export type LayoutSnapshot = {
	/** The newest request id. */
	requestId: number;
	/** Key of the request still waiting for an answer, if any. */
	pendingKey: string | null;
	/** The newest ready result; kept while a later request is pending or fails. */
	ready: LayoutReady | null;
	/** The newest failure, for the request it answered. */
	error: LayoutFailure | null;
};

type Pending = { requestId: number; request: LayoutRequest };

const INITIAL_SNAPSHOT: LayoutSnapshot = {
	error: null,
	pendingKey: null,
	ready: null,
	requestId: 0,
};

export class LayoutClient {
	private readonly factory: LayoutWorkerFactory;
	private worker: LayoutWorkerLike | null = null;
	private workerBroken = false;
	private counter = 0;
	private pending: Pending | null = null;
	private snapshot: LayoutSnapshot = INITIAL_SNAPSHOT;
	private readonly listeners = new Set<() => void>();

	constructor(factory: LayoutWorkerFactory = browserLayoutWorkerFactory) {
		this.factory = factory;
	}

	/** True when requests go to a worker; false when they run synchronously. */
	usesWorker(): boolean {
		return !this.workerBroken && this.factory.available();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): LayoutSnapshot => this.snapshot;

	/**
	 * Asks for the layout of a node set. Returns the id of the request that
	 * answers it: a ready result for the same key is reused, a pending request
	 * for the same key is kept, and anything else supersedes the pending one.
	 */
	request(request: LayoutRequest): number {
		const { key, nodes, nodeLimit } = request;

		// The budget first: no packing, no posting, no pairwise work over it
		if (!isValidNodeLimit(nodeLimit) || nodes.length > nodeLimit) {
			const requestId = this.startRequest(null);
			this.update({
				error: {
					code: "over-budget",
					key,
					message: overBudgetMessage(nodes.length, nodeLimit),
					requestId,
				},
			});
			return requestId;
		}
		if (this.snapshot.ready?.key === key) {
			this.cancel();
			return this.snapshot.ready.requestId;
		}
		if (this.pending?.request.key === key) {
			return this.pending.requestId;
		}

		const requestId = this.startRequest(request);
		const worker = this.ensureWorker();
		if (!worker) {
			this.runSync(requestId, request);
			return requestId;
		}

		let packed: ReturnType<typeof packVectors>;
		try {
			packed = packVectors(nodes);
		} catch (error) {
			this.fail(requestId, request.key, "failed", error);
			return requestId;
		}
		worker.postMessage(
			{
				...packed,
				nodeLimit,
				requestId,
				seed: request.seed,
				type: "compute",
			},
			[packed.vectors.buffer],
		);
		return requestId;
	}

	/** Cancels the pending request (only `requestId`, when given). */
	cancel(requestId?: number): void {
		const pending = this.pending;
		if (!pending) return;
		if (requestId !== undefined && pending.requestId !== requestId) return;
		this.pending = null;
		this.worker?.postMessage({ requestId: pending.requestId, type: "cancel" });
		this.update({ pendingKey: null });
	}

	/** Cancels and stops the worker; a later request starts a new one. */
	dispose(): void {
		this.cancel();
		this.worker?.terminate();
		this.worker = null;
	}

	private startRequest(request: LayoutRequest | null): number {
		if (this.pending) {
			this.worker?.postMessage({
				requestId: this.pending.requestId,
				type: "cancel",
			});
		}
		const requestId = ++this.counter;
		this.pending = request ? { request, requestId } : null;
		this.update({ pendingKey: request?.key ?? null, requestId });
		return requestId;
	}

	private ensureWorker(): LayoutWorkerLike | null {
		if (this.worker) return this.worker;
		if (!this.usesWorker()) return null;
		try {
			const worker = this.factory.create();
			worker.onmessage = (event) => this.handleResponse(event.data);
			worker.onerror = () => this.handleWorkerFailure();
			this.worker = worker;
			return worker;
		} catch {
			this.workerBroken = true;
			return null;
		}
	}

	private handleResponse(response: LayoutWorkerResponse): void {
		const pending = this.pending;
		// Superseded, cancelled or unknown: never replaces the current answer
		if (!pending || response.requestId !== pending.requestId) return;
		if (response.type === "cancelled") return;
		this.pending = null;
		if (response.type === "error") {
			this.update({
				error: {
					code: response.code,
					key: pending.request.key,
					message: response.message,
					requestId: response.requestId,
				},
				pendingKey: null,
			});
			return;
		}
		this.succeed(response.requestId, pending.request, response.result);
	}

	/** The worker could not load or crashed: finish the pending request here. */
	private handleWorkerFailure(): void {
		this.workerBroken = true;
		this.worker?.terminate();
		this.worker = null;
		const pending = this.pending;
		if (pending) this.runSync(pending.requestId, pending.request);
	}

	private runSync(requestId: number, request: LayoutRequest): void {
		try {
			const result = runLayoutSync({
				...packVectors(request.nodes),
				nodeLimit: request.nodeLimit,
				seed: request.seed,
			});
			this.pending = null;
			this.succeed(requestId, request, result);
		} catch (error) {
			this.pending = null;
			this.fail(requestId, request.key, "failed", error);
		}
	}

	private succeed(
		requestId: number,
		request: LayoutRequest,
		result: LayoutOutput,
	): void {
		const geometry = registerGeometryResult({
			centerId: result.centerId,
			key: request.geometryKey,
			mstEdges: result.mstEdges,
			neighbours: result.neighbours,
		});
		this.update({
			error: null,
			pendingKey: null,
			ready: { geometry, key: request.key, requestId, result },
		});
	}

	private fail(
		requestId: number,
		key: string,
		code: LayoutErrorCode,
		error: unknown,
	): void {
		this.update({
			error: {
				code,
				key,
				message: error instanceof Error ? error.message : String(error),
				requestId,
			},
			pendingKey: null,
		});
	}

	private update(partial: Partial<LayoutSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...partial };
		for (const listener of this.listeners) listener();
	}
}
