import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import {
	generateVerificationArtefact,
	getVerificationArtefacts,
	getVerificationTopics,
	type UpdateVerificationArtefactPayload,
	updateVerificationArtefact,
} from "@/lib/api";

export const useVerificationTopics = (projectId: string | undefined) => {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => getVerificationTopics(projectId!),
		queryKey: ["verify", "topics", projectId],
	});
};

// Hook for generating verification artefacts
export const useGenerateVerificationArtefact = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: generateVerificationArtefact,
		onError: (error) => {
			console.error("Failed to generate verification artefact:", error);
			toast.error("Failed to generate artefact. Please try again.");
		},
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({
				queryKey: [
					"verify",
					"conversation_artifacts",
					variables.conversationId,
				],
			});
		},
	});
};

// Hook for saving verification artefacts
type UpdateArtefactVariables = {
	artifactId: string;
	conversationId: string;
	useConversation?: {
		conversationId: string;
		timestamp: string;
	};
	content?: string;
	approvedAt?: string;
	successMessage?: string;
};

export const useUpdateVerificationArtefact = () => {
	const queryClient = useQueryClient();

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
		onError: (error) => {
			console.error("Failed to save verification artefact:", error);
			toast.error("Failed to approve artefact. Please try again.");
		},
		onSuccess: (_data, variables) => {
			toast.success(
				variables?.successMessage ??
					"Verification artefact updated successfully!",
			);
			queryClient.invalidateQueries({
				queryKey: ["conversations", variables.conversationId],
			});
			queryClient.invalidateQueries({
				queryKey: [
					"verify",
					"conversation_artifacts",
					variables.conversationId,
				],
			});
		},
	});
};

// Hook for fetching conversation artefacts
export const useConversationArtefacts = (
	conversationId: string | undefined,
) => {
	return useQuery({
		enabled: !!conversationId,
		queryFn: () => getVerificationArtefacts(conversationId!),
		queryKey: ["verify", "conversation_artifacts", conversationId],
	});
};
