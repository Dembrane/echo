import { useRef } from "react";

const UPLOAD_WAIT_TIMEOUT_MS = 30_000;

// The recorder hands over its last chunk as it stops, so give that upload a
// moment to be tracked before waiting on the set.
const FINAL_CHUNK_GRACE_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tracks chunk uploads still in flight, so leaving the screen (finish,
 * reconnect) can wait for the audio to land first.
 */
export const usePendingUploads = () => {
	const pendingRef = useRef<Promise<unknown>[]>([]);

	const track = (upload: Promise<unknown>) => {
		pendingRef.current.push(upload);
		const untrack = () => {
			pendingRef.current = pendingRef.current.filter((p) => p !== upload);
		};
		// Not .finally(): that hands back a promise rejecting with the upload's
		// error, which nothing handles, so PostHog logged it as an exception.
		upload.then(untrack, untrack);
	};

	const count = () => pendingRef.current.length;

	/** Settles when every tracked upload has, or after 30s, whichever is first. */
	const waitForAll = async (): Promise<"done" | "timeout"> => {
		await sleep(FINAL_CHUNK_GRACE_MS);
		if (pendingRef.current.length === 0) return "done";

		return Promise.race([
			Promise.allSettled(pendingRef.current).then(() => "done" as const),
			sleep(UPLOAD_WAIT_TIMEOUT_MS).then(() => "timeout" as const),
		]);
	};

	return { count, track, waitForAll };
};
