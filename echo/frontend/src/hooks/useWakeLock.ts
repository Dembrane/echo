import { useEffect, useRef, useState } from "react";

export const useWakeLock = ({ obtainWakeLockOnMount = true }) => {
	const wakeLock = useRef<null | WakeLockSentinel>(null);
	const [isSupported, setIsSupported] = useState<boolean>(false);
	const [isActive, setIsActive] = useState<boolean>(false);
	const releaseHandlerRef = useRef<(() => void) | null>(null);

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
			setIsActive(false);
		}
	};

	const obtainWakeLock = async () => {
		if ("wakeLock" in navigator) {
			setIsSupported(true);
			try {
				// Release old wakelock BEFORE requesting a new one
				if (wakeLock.current) {
					// Remove old listener first
					if (releaseHandlerRef.current) {
						wakeLock.current.removeEventListener(
							"release",
							releaseHandlerRef.current,
						);
						releaseHandlerRef.current = null;
					}
					await wakeLock.current.release();
					wakeLock.current = null;
				}

				// Now request the new wakelock
				const wakelock = await navigator.wakeLock.request("screen");
				if (wakelock) {
					wakeLock.current = wakelock;
					setIsActive(true);

					const handleRelease = () => {
						setIsActive(false);
					};
					releaseHandlerRef.current = handleRelease;
					wakelock.addEventListener("release", handleRelease);
				}
			} catch (_err) {
				setIsActive(false);
			}
		} else {
			setIsSupported(false);
			setIsActive(false);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: no dependency needed
	useEffect(() => {
		if (obtainWakeLockOnMount) {
			obtainWakeLock();
		}
		// Re-acquire wake lock when tab becomes visible again
		const handleVisibilityChange = () => {
			if (
				!document.hidden &&
				(!wakeLock.current || wakeLock.current.released)
			) {
				obtainWakeLock();
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			releaseWakeLock();
		};
	}, []);

	return {
		isActive,
		isSupported,
		obtainWakeLock,
		releaseWakeLock,
		wakeLock,
	};
};
