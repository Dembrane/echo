import {
	confirmConversationChunkUpload,
	finishConversation,
	uploadConversationChunk,
} from "@/lib/api";
import type { OutboxApi } from "./drainOutbox";

/** The drainer's view of the participant API: the same calls the portal made before. */
export const outboxApi: OutboxApi = {
	confirm: (item, { chunk_id, file_url }) =>
		confirmConversationChunkUpload({
			chunk_id,
			conversationId: item.conversationId,
			file_url,
			source: item.source,
			timestamp: item.timestamp,
		}),
	finish: (conversationId) => finishConversation(conversationId),
	upload: async (item) => {
		const { chunk_id, file_url } = await uploadConversationChunk({
			chunk: new Blob([item.audio], { type: item.mimeType }),
			conversationId: item.conversationId,
			source: item.source,
			timestamp: new Date(item.timestamp),
		});
		return { chunk_id, file_url };
	},
};
