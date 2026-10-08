type ThreadMessage = { content: string; id: string; role: string };

/** The partial reply worth saving on stop; null if no answer had started streaming. */
export const stoppedAnswer = <T extends ThreadMessage>(
	messages: T[],
): T | null => {
	const last = messages[messages.length - 1];
	return last?.role === "assistant" && last.content.trim() ? last : null;
};
