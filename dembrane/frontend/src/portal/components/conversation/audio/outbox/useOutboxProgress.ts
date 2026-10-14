import { useState } from "react";
import { useOutbox } from "./OutboxProvider";

/**
 * How far this conversation's queued chunks have got: `sent` of `total`,
 * counted from when the queue was last empty. Both are 0 while it is.
 */
export const useOutboxProgress = (conversationId: string) => {
	const queued = useOutbox().queuedCount(conversationId);
	const [total, setTotal] = useState(queued);
	// Grows as chunks join, and starts over once the queue empties.
	if (queued === 0 ? total !== 0 : queued > total) setTotal(queued);
	const shownTotal = queued === 0 ? 0 : Math.max(total, queued);
	return { queued, sent: shownTotal - queued, total: shownTotal };
};
