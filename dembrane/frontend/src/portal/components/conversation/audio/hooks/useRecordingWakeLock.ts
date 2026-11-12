import { useWakeLock } from "@/hooks/useWakeLock";

/**
 * Keeps the screen awake while recording. `hold` must run from a user gesture
 * for the browser to grant it; it re-acquires the lock after the tab returns
 * until `release`.
 */
export const useRecordingWakeLock = () => {
	const wakeLock = useWakeLock();

	const hold = () => {
		if (!wakeLock.isSupported) return;
		wakeLock.obtainWakeLock();
		wakeLock.enableAutoReacquire();
	};

	const release = () => {
		wakeLock.releaseWakeLock();
		wakeLock.disableAutoReacquire();
	};

	return { hold, isSupported: wakeLock.isSupported, release };
};
