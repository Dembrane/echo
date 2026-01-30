import { useEffect, useRef } from "react";

const MINIMAL_VIDEO_BASE64 =
	"data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMQbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjp0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGybWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAR1zdGJsAAAAuXN0c2QAAAAAAAAAAQAAAKlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAK/+EAF2dCwArafiIjARAAAAMAEAAAAwAg8SJqAQAFaM4BlyAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAATMAAAEzAAAAAYc3R0cwAAAAAAAAABAAAAAQAAQAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAACZgAAAAEAAAAUc3RjbwAAAAAAAAABAAADQAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAACGZyZWUAAAJubWRhdAAAAlUGBf//UdxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDotMzotMyBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9Mi4wMDowLjcwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9NTEuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAAAJZYiEOiYoABXA";

export const useVideoWakeLockFallback = ({
	isRecording,
	isWakeLockSupported,
}: {
	isRecording: boolean;
	isWakeLockSupported: boolean;
}) => {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const visibilityHandlerRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		// Only activate fallback if:
		// 1. User is recording, AND
		// 2. Wakelock is not supported at all
		// (Auto-reacquire handles temporary wakelock losses)
		const shouldActivateFallback = isRecording && !isWakeLockSupported;

		if (!shouldActivateFallback) {
			// Clean up video element if it exists
			if (videoRef.current) {
				videoRef.current.pause();
				videoRef.current.src = "";
				videoRef.current.remove();
				videoRef.current = null;
				console.log("[VideoWakeLockFallback] Cleaned up video - not needed");
			}
			if (checkIntervalRef.current) {
				clearInterval(checkIntervalRef.current);
				checkIntervalRef.current = null;
			}
			if (visibilityHandlerRef.current) {
				document.removeEventListener(
					"visibilitychange",
					visibilityHandlerRef.current,
				);
				visibilityHandlerRef.current = null;
			}
			return;
		}

		// If video already exists, don't create a new one
		if (videoRef.current) {
			console.log(
				"[VideoWakeLockFallback] Video already active, skipping creation",
			);
			return;
		}

		// Create a minimal 1x1 pixel video element
		try {
			console.log(
				"[VideoWakeLockFallback] Activating video fallback - wakelock not available",
			);

			// Create video element
			const video = document.createElement("video");
			video.style.position = "fixed";
			video.style.top = "-9999px";
			video.style.left = "-9999px";
			video.style.width = "1px";
			video.style.height = "1px";
			video.style.opacity = "0";
			video.style.pointerEvents = "none";
			video.style.zIndex = "-9999";
			video.setAttribute("playsinline", "true");
			video.setAttribute("webkit-playsinline", "true");
			video.muted = true;
			video.loop = true;
			video.src = MINIMAL_VIDEO_BASE64;
			videoRef.current = video;

			// Append to DOM (required for iOS)
			document.body.appendChild(video);
			video.load();

			// Play the video
			const playVideo = async () => {
				try {
					await video.play().catch(() => {
						console.log(
							"[VideoWakeLockFallback] First play failed, retrying in 1s...",
						);
						setTimeout(() => {
							video.play().catch(() => {
								console.warn("[VideoWakeLockFallback] Retry also failed");
							});
						}, 4000);
					});
				} catch (error) {
					console.warn(
						"[VideoWakeLockFallback] Failed to play fallback video:",
						error,
					);
				}
			};

			playVideo();

			// Periodically check if video is still playing and restart if needed
			// (iOS can sometimes pause background videos)
			checkIntervalRef.current = setInterval(() => {
				if (videoRef.current?.paused) {
					console.log(
						"[VideoWakeLockFallback] Video was paused, restarting...",
					);
					playVideo();
				}
			}, 5000); // Check every 5 seconds

			// Handle visibility change - restart video when tab becomes visible
			const handleVisibilityChange = () => {
				if (
					document.visibilityState === "visible" &&
					videoRef.current?.paused
				) {
					console.log(
						"[VideoWakeLockFallback] Tab visible again, restarting video...",
					);
					playVideo();
				}
			};

			visibilityHandlerRef.current = handleVisibilityChange;
			document.addEventListener("visibilitychange", handleVisibilityChange);
		} catch (error) {
			console.error(
				"[VideoWakeLockFallback] Failed to create fallback video:",
				error,
			);
		}

		// Cleanup on unmount or when conditions change
		return () => {
			if (videoRef.current) {
				videoRef.current.pause();
				videoRef.current.src = "";
				videoRef.current.remove();
				videoRef.current = null;
			}
			if (checkIntervalRef.current) {
				clearInterval(checkIntervalRef.current);
				checkIntervalRef.current = null;
			}
			if (visibilityHandlerRef.current) {
				document.removeEventListener(
					"visibilitychange",
					visibilityHandlerRef.current,
				);
				visibilityHandlerRef.current = null;
			}
		};
	}, [isRecording, isWakeLockSupported]);

	return {
		isActive: isRecording && !isWakeLockSupported,
		videoElement: videoRef.current,
	};
};
