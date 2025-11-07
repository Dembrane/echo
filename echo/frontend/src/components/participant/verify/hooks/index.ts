import { readItems } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import {
	generateVerificationArtefact,
	getVerificationTopics,
	updateVerificationArtefact,
	type UpdateVerificationArtefactPayload,
} from "@/lib/api";
import { directus } from "@/lib/directus";

export const useVerificationTopics = (projectId: string | undefined) => {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => getVerificationTopics(projectId!),
		queryKey: ["verify", "topics", projectId],
	});
};

// Hook for generating verification artefacts
export const useGenerateVerificationArtefact = () => {
	return useMutation({
		mutationFn: generateVerificationArtefact,
		onError: (error) => {
			console.error("Failed to generate verification artefact:", error);
			toast.error("Failed to generate artefact. Please try again.");
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
				artifactId,
				useConversation,
				content,
				approvedAt,
			};
			return updateVerificationArtefact(payload);
		},
		onError: (error) => {
			console.error("Failed to save verification artefact:", error);
			toast.error("Failed to approve artefact. Please try again.");
		},
		onSuccess: (_data, variables) => {
			toast.success(
				variables?.successMessage ?? "Verification artefact updated successfully!",
			);
			queryClient.invalidateQueries({
				queryKey: ["conversations", variables.conversationId],
			});
			queryClient.invalidateQueries({
				queryKey: ["conversation_artefacts", variables.conversationId],
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
		queryFn: () =>
			directus.request(
				readItems("conversation_artefact", {
					fields: ["id", "conversation_id", "approved_at", "key"],
					filter: { conversation_id: { _eq: conversationId } },
					sort: ["-approved_at"],
				}),
			),
		queryKey: ["conversation_artefacts", conversationId],
	});
};

// Hook for fetching a single artefact by ID (with aggressive caching - content never changes)
export const useConversationArtefact = (artefactId: string | undefined) => {
	return useQuery({
		enabled: !!artefactId,
		queryFn: () =>
			directus.request(
				readItems("conversation_artefact", {
					fields: ["id", "content", "conversation_id", "approved_at"],
					filter: { id: { _eq: artefactId } },
					limit: 1,
				}),
			),
		queryKey: ["conversation_artefact", artefactId],
		select: (data) => (data.length > 0 ? data[0] : null),
		staleTime: Number.POSITIVE_INFINITY,
	});
};
