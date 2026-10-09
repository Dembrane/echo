import { useCallback, useRef } from "react";

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

	const track = useCallback((upload: Promise<unknown>) => {
		pendingRef.current.push(upload);
		upload.finally(() => {
			pendingRef.current = pendingRef.current.filter((p) => p !== upload);
		});
	}, []);

	const count = useCallback(() => pendingRef.current.length, []);

	/** Settles when every tracked upload has, or after 30s, whichever is first. */
	const waitForAll = useCallback(async (): Promise<"done" | "timeout"> => {
		await sleep(FINAL_CHUNK_GRACE_MS);
		if (pendingRef.current.length === 0) return "done";

		return Promise.race([
			Promise.allSettled(pendingRef.current).then(() => "done" as const),
			sleep(UPLOAD_WAIT_TIMEOUT_MS).then(() => "timeout" as const),
		]);
	}, []);

	return { count, track, waitForAll };
};
