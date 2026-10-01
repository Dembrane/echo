export function getChunkIdFromReference(
	reference: Record<string, unknown>,
): string | null {
	const direct =
		reference.chunk_id ??
		reference.conversation_chunk_id ??
		reference.chunkId ??
		reference.conversationChunkId;
	if (typeof direct === "string" && direct.trim()) return direct.trim();

	const chunk = reference.chunk ?? reference.conversation_chunk;
	if (chunk && typeof chunk === "object" && "id" in chunk) {
		const chunkId = (chunk as { id?: unknown }).id;
		if (typeof chunkId === "string" && chunkId.trim()) return chunkId.trim();
	}

	return null;
}

export function conversationReferencePath({
	chunkId,
	conversationId,
	projectId,
	workspaceId,
}: {
	chunkId?: string | null;
	conversationId: string;
	projectId: string;
	workspaceId: string;
}): string {
	const anchor = chunkId ? `#chunk-${encodeURIComponent(chunkId)}` : "";
	return `/w/${workspaceId}/projects/${projectId}/conversations/${encodeURIComponent(
		conversationId,
	)}${anchor}`;
}
