import { useEffect, useRef } from "react";

const MINIMAL_VIDEO_BASE64 =
	"data:video/mp4;base64,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";

export const useVideoWakeLockFallback = ({
	isRecording,
	isWakeLockActive,
}: {
	isRecording: boolean;
	isWakeLockActive: boolean;
}) => {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const checkIntervalRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		// Only activate fallback if recording AND wakelock is not active
		const shouldActivateFallback = isRecording && !isWakeLockActive;

		if (!shouldActivateFallback) {
			// Clean up video element if it exists
			if (videoRef.current) {
				videoRef.current.pause();
				videoRef.current.src = "";
				videoRef.current.remove();
				videoRef.current = null;
				console.log(
					"[VideoWakeLockFallback] Cleaned up video - wakelock is working",
				);
			}
			if (checkIntervalRef.current) {
				clearInterval(checkIntervalRef.current);
				checkIntervalRef.current = null;
			}
			return;
		}

		// If video already exists, don't create a new one
		// The cleanup function at the end of this effect will handle cleanup when needed
		if (videoRef.current) {
			console.log(
				"[VideoWakeLockFallback] Video already active, skipping creation",
			);
			return;
		}

		// Create a minimal 1x1 pixel video element
		try {
			console.log(
				"[VideoWakeLockFallback] Activating video fallback - wakelock not active",
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

			// Play the video
			const playVideo = async () => {
				try {
					await video.play();
					console.log(
						"[VideoWakeLockFallback] Silent 1-pixel video playing as fallback for wakelock",
					);
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
		};
	}, [isRecording, isWakeLockActive]);

	return {
		isActive: isRecording && !isWakeLockActive,
		videoElement: videoRef.current,
	};
};
