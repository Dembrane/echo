import { useEffect, useRef, useState } from "react";

export const useWakeLock = () => {
	const wakeLock = useRef<null | WakeLockSentinel>(null);
	const [isSupported, setIsSupported] = useState<boolean>(false);
	const [isActive, setIsActive] = useState<boolean>(false);
	const releaseHandlerRef = useRef<(() => void) | null>(null);
	const visibilityHandlerRef = useRef<(() => void) | null>(null);

	// Check support on mount
	useEffect(() => {
		if ("wakeLock" in navigator) {
			setIsSupported(true);
			console.log("[WakeLock] Screen Wake Lock API supported");
		} else {
			setIsSupported(false);
			console.log("[WakeLock] Screen Wake Lock API not supported");
		}
	}, []);

	const releaseWakeLock = () => {
		if (wakeLock.current) {
			if (releaseHandlerRef.current) {
				wakeLock.current.removeEventListener(
					"release",
					releaseHandlerRef.current,
				);
				releaseHandlerRef.current = null;
			}
			wakeLock.current.release();
			wakeLock.current = null;
			console.log("[WakeLock] Released");
		}
		// Only update state once at the end (avoid redundant updates)
		setIsActive(false);
	};

	const obtainWakeLock = async () => {
		// Only attempt if supported
		if (!("wakeLock" in navigator)) {
			console.warn("[WakeLock] Cannot obtain - API not supported");
			setIsSupported(false);
			setIsActive(false);
			return;
		}

		try {
			// Request new wakelock FIRST to avoid gap where screen can sleep
			const newWakeLock = await navigator.wakeLock.request("screen");

			// THEN release old one (if exists)
			if (wakeLock.current) {
				if (releaseHandlerRef.current) {
					wakeLock.current.removeEventListener(
						"release",
						releaseHandlerRef.current,
					);
					releaseHandlerRef.current = null;
				}
				await wakeLock.current.release();
			}

			// Now assign the new one
			wakeLock.current = newWakeLock;
			setIsActive(true);
			console.log("[WakeLock] Acquired");

			const handleRelease = () => {
				setIsActive(false);
				console.log("[WakeLock] Released by system");
			};
			releaseHandlerRef.current = handleRelease;
			newWakeLock.addEventListener("release", handleRelease);
		} catch (err) {
			// Wake lock request can fail due to:
			// - Battery saver mode
			// - System policy
			// - No user interaction yet
			console.warn("[WakeLock] Failed to acquire:", err);
			setIsActive(false);
		}
	};

	// Setup visibility change handler to auto-reacquire when tab becomes visible
	const enableAutoReacquire = () => {
		// Don't add handler if already exists or if not supported
		if (visibilityHandlerRef.current || !("wakeLock" in navigator)) {
			return;
		}

		const handleVisibilityChange = () => {
			if (
				document.visibilityState === "visible" &&
				(!wakeLock.current || wakeLock.current.released)
			) {
				console.log("[WakeLock] Tab visible again, re-acquiring...");
				obtainWakeLock();
			}
		};

		visibilityHandlerRef.current = handleVisibilityChange;
		document.addEventListener("visibilitychange", handleVisibilityChange);
		console.log("[WakeLock] Auto-reacquire enabled");
	};

	const disableAutoReacquire = () => {
		if (visibilityHandlerRef.current) {
			document.removeEventListener(
				"visibilitychange",
				visibilityHandlerRef.current,
			);
			visibilityHandlerRef.current = null;
			console.log("[WakeLock] Auto-reacquire disabled");
		}
	};

	// Cleanup on unmount
	// biome-ignore lint/correctness/useExhaustiveDependencies: cleanup functions are stable and don't need deps
	useEffect(() => {
		return () => {
			disableAutoReacquire();
			releaseWakeLock();
		};
	}, []);

	return {
		disableAutoReacquire,
		enableAutoReacquire,
		isActive,
		isSupported,
		obtainWakeLock,
		releaseWakeLock,
		wakeLock,
	};
};
