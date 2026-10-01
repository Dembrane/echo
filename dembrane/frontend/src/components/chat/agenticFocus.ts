// Reads the host's "focusing on" selection stamped into a user.message
// event payload by the agentic API.
export const focusedConversationIdsFromPayload = (
	payload: unknown,
): string[] => {
	if (!payload || typeof payload !== "object") return [];
	const value = (payload as Record<string, unknown>).focused_conversation_ids;
	if (!Array.isArray(value)) return [];
	return value.filter(
		(id): id is string => typeof id === "string" && id.length > 0,
	);
};
