/**
 * Layout worker: distances, MST, centre and LocalMap neighbours off the UI
 * thread. See runner.ts for the protocol handling and compute.ts for the
 * computation.
 */
import type { LayoutWorkerRequest, LayoutWorkerResponse } from "./protocol";
import { createLayoutWorkerHandler } from "./runner";

type WorkerScope = {
	postMessage: (message: LayoutWorkerResponse) => void;
	onmessage: ((event: MessageEvent<LayoutWorkerRequest>) => void) | null;
};

const scope = self as unknown as WorkerScope;

// A message-channel round trip lets queued compute and cancel messages run
// between slices, without the clamping of nested timers
const channel = new MessageChannel();
const waiting: Array<() => void> = [];
channel.port1.onmessage = () => {
	waiting.shift()?.();
};
const yieldControl = () =>
	new Promise<void>((resolve) => {
		waiting.push(resolve);
		channel.port2.postMessage(null);
	});

const handle = createLayoutWorkerHandler(
	(response) => scope.postMessage(response),
	yieldControl,
);

scope.onmessage = (event) => {
	void handle(event.data);
};
