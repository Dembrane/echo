/**
 * A layout worker for tests: records what the client posts and answers
 * compute messages on request, with the real computation.
 */
import type { LayoutWorkerFactory, LayoutWorkerLike } from "./client";
import { runLayoutSync } from "./compute";
import type {
	LayoutComputeMessage,
	LayoutWorkerRequest,
	LayoutWorkerResponse,
} from "./protocol";

export class FakeLayoutWorker implements LayoutWorkerLike {
	onmessage: ((event: { data: LayoutWorkerResponse }) => void) | null = null;
	onerror: ((event: { message?: string }) => void) | null = null;
	terminated = false;
	readonly posted: LayoutWorkerRequest[] = [];

	postMessage(message: LayoutWorkerRequest) {
		this.posted.push(message);
	}

	terminate() {
		this.terminated = true;
	}

	computes(): LayoutComputeMessage[] {
		return this.posted.filter(
			(message): message is LayoutComputeMessage => message.type === "compute",
		);
	}

	cancels(): number[] {
		return this.posted
			.filter((message) => message.type === "cancel")
			.map((message) => message.requestId);
	}

	/** Answers a compute as the worker would. */
	answer(message: LayoutComputeMessage) {
		this.onmessage?.({
			data: {
				requestId: message.requestId,
				result: runLayoutSync(message),
				type: "result",
			},
		});
	}
}

export const fakeWorkerFactory = (
	worker: FakeLayoutWorker,
): LayoutWorkerFactory => ({
	available: () => true,
	create: () => worker,
});
