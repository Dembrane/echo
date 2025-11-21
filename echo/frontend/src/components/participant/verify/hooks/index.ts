import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	generateVerificationArtefact,
	getVerificationArtefactById,
	getVerificationArtefacts,
	getVerificationTopics,
	type UpdateVerificationArtefactPayload,
	updateVerificationArtefact,
	type VerificationArtifact,
	type VerificationArtifactDetail,
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
type GenerateArtefactVariables = {
	conversationId: string;
	topicKey: string;
};

export const useGenerateVerificationArtefactMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({
			conversationId,
			topicKey,
		}: GenerateArtefactVariables): Promise<VerificationArtifact> => {
			const generatedArtefacts = await generateVerificationArtefact({
				conversationId,
				topicList: [topicKey],
			});

			const artefact = generatedArtefacts[0];
			if (!artefact) {
				throw new Error("No artefact returned from generate endpoint.");
			}

			queryClient.setQueryData(
				["verify", "artifact_by_topic", conversationId, topicKey],
				artefact,
			);
			queryClient.setQueryData(
				["verify", "artifact_by_id", artefact.id],
				artefact,
			);

			return artefact;
		},
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

export const useVerificationArtefactById = (
	conversationId: string | undefined,
	artifactId: string | null | undefined,
) => {
	const queryClient = useQueryClient();

	return useQuery({
		enabled: !!conversationId && !!artifactId,
		queryFn: async (): Promise<VerificationArtifactDetail | null> => {
			if (!conversationId || !artifactId) {
				return null;
			}

			const cachedArtifact =
				queryClient.getQueryData<VerificationArtifactDetail>([
					"verify",
					"artifact_by_id",
					artifactId,
				]);
			if (cachedArtifact) {
				return cachedArtifact;
			}

			const artefact = await getVerificationArtefactById(artifactId);

			queryClient.setQueryData(
				["verify", "artifact_by_id", artifactId],
				artefact,
			);

			return artefact;
		},
		queryKey: ["verify", "artifact_by_id", artifactId],
		refetchOnWindowFocus: false,
		retry: 1,
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
