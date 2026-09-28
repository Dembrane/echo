/**
 * The worker side of the layout protocol, without the Worker: runs compute
 * messages in time slices, takes newer requests and cancellations between
 * slices, and answers with results or errors. layout.worker.ts wires it to
 * the worker scope; tests drive it directly.
 */
import { LayoutBudgetError, layoutSteps } from "./compute";
import type {
	LayoutComputeMessage,
	LayoutWorkerRequest,
	LayoutWorkerResponse,
} from "./protocol";

export type LayoutJobControl = {
	/** True once the job is superseded or cancelled. */
	isCancelled: () => boolean;
	/** Lets queued messages run; resolves when the job may continue. */
	yieldControl: () => Promise<void>;
	/** Work this long before yielding. */
	sliceMs?: number;
};

const DEFAULT_SLICE_MS = 12;

/** Runs one compute message to a response, pausing between slices. */
export async function runLayoutJob(
	message: LayoutComputeMessage,
	control: LayoutJobControl,
): Promise<LayoutWorkerResponse> {
	const { requestId } = message;
	const sliceMs = control.sliceMs ?? DEFAULT_SLICE_MS;
	if (control.isCancelled()) return { requestId, type: "cancelled" };

	try {
		const steps = layoutSteps(message);
		let sliceStart = performance.now();
		let paused = 0;
		for (;;) {
			const step = steps.next(paused);
			paused = 0;
			if (step.done) {
				return { requestId, result: step.value, type: "result" };
			}
			if (performance.now() - sliceStart >= sliceMs) {
				const pauseStart = performance.now();
				await control.yieldControl();
				if (control.isCancelled()) return { requestId, type: "cancelled" };
				sliceStart = performance.now();
				paused = sliceStart - pauseStart;
			}
		}
	} catch (error) {
		if (error instanceof LayoutBudgetError) {
			return {
				code: "over-budget",
				message: error.message,
				requestId,
				type: "error",
			};
		}
		return {
			code: "failed",
			message: error instanceof Error ? error.message : String(error),
			requestId,
			type: "error",
		};
	}
}

/**
 * Message handler for the layout worker. A compute supersedes every older
 * request still running; a cancel stops its request. Superseded and
 * cancelled jobs post nothing.
 */
export function createLayoutWorkerHandler(
	post: (response: LayoutWorkerResponse) => void,
	yieldControl: () => Promise<void>,
	sliceMs?: number,
): (message: LayoutWorkerRequest) => Promise<void> {
	let newestRequestId = 0;
	const cancelled = new Set<number>();

	return async (message) => {
		if (message.type === "cancel") {
			cancelled.add(message.requestId);
			return;
		}
		const { requestId } = message;
		newestRequestId = Math.max(newestRequestId, requestId);
		const response = await runLayoutJob(message, {
			isCancelled: () =>
				requestId < newestRequestId || cancelled.has(requestId),
			sliceMs,
			yieldControl,
		});
		cancelled.delete(requestId);
		if (response.type !== "cancelled") post(response);
	};
}
