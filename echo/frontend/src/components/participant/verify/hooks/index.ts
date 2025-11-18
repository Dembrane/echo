import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { toast } from "@/components/common/Toaster";
import {
	generateVerificationArtefact,
	getVerificationArtefacts,
	getVerificationTopics,
	type UpdateVerificationArtefactPayload,
	updateVerificationArtefact,
	type VerificationArtifact,
} from "@/lib/api";

export const useVerificationTopics = (projectId: string | undefined) => {
	return useQuery({
		enabled: !!projectId,
		// biome-ignore lint/style/noNonNullAssertion: projectId is guaranteed to be defined
		queryFn: () => getVerificationTopics(projectId!),
		queryKey: ["verify", "topics", projectId],
	});
};

// Hook for generating verification artefacts
export const useGenerateVerificationArtefact = (
	conversationId: string | undefined,
	topicKey: string | undefined,
	enabled = true,
) => {
	return useQuery({
		enabled: !!conversationId && !!topicKey && enabled,
		queryFn: async (): Promise<VerificationArtifact | null> => {
			const generatedArtefacts = await generateVerificationArtefact({
				conversationId: conversationId ?? "",
				topicList: [topicKey ?? ""],
			});

			return generatedArtefacts[0] ?? null;
		},
		queryKey: ["verify", "artifact_by_topic", conversationId, topicKey],
		refetchOnWindowFocus: false,
		retry: 1,
	});
};

type UpdateArtefactVariables = {
	artifactId: string;
	conversationId: string;
	useConversation?: {
		conversationId: string;
		timestamp: string;
	};
	content?: string;
	approvedAt?: string;
};

export const useUpdateVerificationArtefact = () => {
	return useMutation({
		mutationFn: async ({
			artifactId,
			useConversation,
			content,
			approvedAt,
		}: UpdateArtefactVariables) => {
			const payload: UpdateVerificationArtefactPayload = {
				approvedAt,
				artifactId,
				content,
				useConversation,
			};
			return updateVerificationArtefact(payload);
		},
	});
};

// Hook for fetching conversation artefacts
export const useConversationArtefacts = (
	conversationId: string | undefined,
) => {
	return useQuery({
		enabled: !!conversationId,
		// biome-ignore lint/style/noNonNullAssertion: conversationId is guaranteed to be undefined
		queryFn: () => getVerificationArtefacts(conversationId!),
		queryKey: ["verify", "conversation_artifacts", conversationId],
	});
};
