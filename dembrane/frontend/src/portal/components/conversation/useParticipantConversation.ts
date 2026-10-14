import posthog from "posthog-js";
import { useProjectSharingLink } from "@/components/project/ProjectQRCode";
import { finishConversation } from "@/lib/api";
import {
	useConversationChunksQuery,
	useConversationQuery,
} from "@/portal/components/conversation/queries";
import { useParticipantProjectById } from "@/portal/hooks/useParticipantProjectById";

/**
 * What the audio and text screens both stand on: the project, the
 * conversation and its chunks, a link to start over, and finishing.
 */
export const useParticipantConversation = (
	projectId: string | undefined,
	conversationId: string | undefined,
) => {
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const conversationQuery = useConversationQuery(projectId, conversationId);
	const chunksQuery = useConversationChunksQuery(projectId, conversationId);
	const newConversationLink = useProjectSharingLink(
		projectQuery.data,
		"portal",
	);

	const loadState: "loading" | "failed" | "ready" =
		conversationQuery.isLoading || projectQuery.isLoading
			? "loading"
			: conversationQuery.isError || !conversationQuery.data
				? "failed"
				: "ready";

	// Finishing and its analytics event go together, whichever screen it is.
	const finish = async () => {
		await finishConversation(conversationId ?? "");
		posthog.capture("conversation_finished", {
			conversation_id: conversationId,
			project_id: projectId,
		});
	};

	return {
		chunksQuery,
		conversationQuery,
		finish,
		loadState,
		newConversationLink,
		projectQuery,
	};
};
