import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "@/components/common/Toaster";

// JSON value type for stream data (matches @ai-sdk/ui-utils JSONValue)
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/**
 * Status event types from the backend stream.
 */
type StreamStatusType = "processing" | "retrying" | "high_load" | "ready";

interface StreamStatusEvent {
	type: StreamStatusType;
	message: string;
	attempt?: number;
}

/**
 * Type guard to check if an item is a StreamStatusEvent.
 */
function isStreamStatusEvent(item: unknown): item is StreamStatusEvent {
	return (
		item !== null &&
		typeof item === "object" &&
		"type" in item &&
		"message" in item &&
		typeof (item as StreamStatusEvent).type === "string" &&
		typeof (item as StreamStatusEvent).message === "string"
	);
}

/**
 * Parse status events from the useChat data array.
 */
function parseStatusEvents(data: JSONValue[] | undefined): StreamStatusEvent[] {
	if (!data || !Array.isArray(data)) {
		return [];
	}

	const events: StreamStatusEvent[] = [];
	for (const item of data) {
		if (isStreamStatusEvent(item)) {
			events.push(item);
		}
	}
	return events;
}

/**
 * Request browser notification permission.
 */
async function requestNotificationPermission(): Promise<boolean> {
	if (!("Notification" in window)) {
		return false;
	}

	if (Notification.permission === "granted") {
		return true;
	}

	if (Notification.permission !== "denied") {
		const permission = await Notification.requestPermission();
		return permission === "granted";
	}

	return false;
}

/**
 * Show a browser notification.
 */
function showBrowserNotification(title: string, body: string) {
	if (Notification.permission === "granted") {
		const notification = new Notification(title, {
			body,
			icon: "/logo.svg",
			tag: "dembrane-response-ready",
		});

		// Focus window when clicked
		notification.onclick = () => {
			window.focus();
			notification.close();
		};
	}
}

export interface UseLoadNotificationOptions {
	/** useChat's data array */
	data: JSONValue[] | undefined;
	/** Whether the chat is currently loading */
	isLoading: boolean;
	/** Whether we've received any content */
	hasContent: boolean;
}

export interface UseLoadNotificationReturn {
	/** Whether we're showing a high load notification */
	isHighLoad: boolean;
	/** Request to be notified when response is ready */
	requestNotification: () => Promise<void>;
	/** Whether notification was requested */
	notificationRequested: boolean;
}

/**
 * Hook to handle load status notifications from the chat stream.
 *
 * Shows a toast when the backend reports high load, and optionally
 * sends a browser notification when the response is ready.
 */
export function useLoadNotification({
	data,
	isLoading,
	hasContent,
}: UseLoadNotificationOptions): UseLoadNotificationReturn {
	const [isHighLoad, setIsHighLoad] = useState(false);
	const [notificationRequested, setNotificationRequested] = useState(false);
	const toastIdRef = useRef<string | number | null>(null);
	const prevDataLengthRef = useRef(0);

	// Parse status events from data
	const statusEvents = parseStatusEvents(data);

	// Handle new status events
	useEffect(() => {
		const currentLength = statusEvents.length;
		if (currentLength <= prevDataLengthRef.current) {
			return;
		}
		prevDataLengthRef.current = currentLength;

		// Check for high_load events
		const latestEvent = statusEvents[statusEvents.length - 1];
		if (latestEvent?.type === "high_load") {
			setIsHighLoad(true);

			// Show persistent toast with notify button
			if (!toastIdRef.current) {
				toastIdRef.current = toast(latestEvent.message, {
					duration: Number.POSITIVE_INFINITY,
					action: {
						label: "Notify me",
						onClick: () => {
							handleRequestNotification();
						},
					},
				});
			}
		}
	}, [statusEvents]);

	// Handle response completion
	useEffect(() => {
		if (!isLoading && hasContent) {
			// Response finished
			setIsHighLoad(false);

			// Dismiss the load toast
			if (toastIdRef.current) {
				toast.dismiss(toastIdRef.current);
				toastIdRef.current = null;
			}

			// Send browser notification if requested
			if (notificationRequested) {
				showBrowserNotification(
					"Response ready",
					"Your chat response is ready to view.",
				);
				setNotificationRequested(false);
			}
		}
	}, [isLoading, hasContent, notificationRequested]);

	// Reset state when loading starts
	useEffect(() => {
		if (isLoading) {
			prevDataLengthRef.current = 0;
		}
	}, [isLoading]);

	const handleRequestNotification = useCallback(async () => {
		const granted = await requestNotificationPermission();
		if (granted) {
			setNotificationRequested(true);
			toast.success("We'll notify you when the response is ready.", {
				duration: 3000,
			});

			// Dismiss the high load toast
			if (toastIdRef.current) {
				toast.dismiss(toastIdRef.current);
				toastIdRef.current = null;
			}
		} else {
			toast.error("Notification permission denied. Please enable notifications in your browser settings.", {
				duration: 5000,
			});
		}
	}, []);

	return {
		isHighLoad,
		requestNotification: handleRequestNotification,
		notificationRequested,
	};
}

