import { useEffect, useRef, useState } from "react";

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

export interface UseLoadNotificationOptions {
	/** useChat's data array */
	data: JSONValue[] | undefined;
	/** Whether the chat is currently loading */
	isLoading: boolean;
	/** Whether we've received any content */
	hasContent: boolean;
}

export interface UseLoadNotificationReturn {
	/** Whether we're experiencing high load */
	isHighLoad: boolean;
	/** Status message to display inline */
	statusMessage: string | null;
}

/**
 * Hook to handle load status from the chat stream.
 *
 * Returns state for inline display when the backend reports high load.
 */
export function useLoadNotification({
	data,
	isLoading,
	hasContent,
}: UseLoadNotificationOptions): UseLoadNotificationReturn {
	const [isHighLoad, setIsHighLoad] = useState(false);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
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
			setStatusMessage(latestEvent.message);
		}
	}, [statusEvents]);

	// Handle response completion
	useEffect(() => {
		if (!isLoading && hasContent) {
			// Response finished - reset state
			setIsHighLoad(false);
			setStatusMessage(null);
		}
	}, [isLoading, hasContent]);

	// Reset state when loading starts
	useEffect(() => {
		if (isLoading) {
			prevDataLengthRef.current = 0;
			setIsHighLoad(false);
			setStatusMessage(null);
		}
	}, [isLoading]);

	return {
		isHighLoad,
		statusMessage,
	};
}
