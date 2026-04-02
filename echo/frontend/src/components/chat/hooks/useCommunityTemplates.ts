import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	copyTemplate,
	getCommunityTemplates,
	getMyCommunityStars,
	publishTemplate,
	toggleTemplateStar,
	unpublishTemplate,
	type CommunityTemplateParams,
} from "@/lib/api";

// ── Community Templates ──

export const useCommunityTemplates = (params: CommunityTemplateParams = {}) => {
	return useQuery({
		queryFn: () => getCommunityTemplates(params),
		queryKey: ["community_templates", params],
	});
};

export const useMyCommunityStars = () => {
	return useQuery({
		queryFn: async () => {
			const ids = await getMyCommunityStars();
			return new Set(ids);
		},
		queryKey: ["community_stars"],
	});
};

export const usePublishTemplate = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			templateId,
			payload,
		}: {
			templateId: string;
			payload: {
				description?: string | null;
				tags?: string[] | null;
				language?: string | null;
				is_anonymous?: boolean;
			};
		}) => publishTemplate(templateId, payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["prompt_templates"] });
			queryClient.invalidateQueries({ queryKey: ["community_templates"] });
		},
	});
};

export const useUnpublishTemplate = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (templateId: string) => unpublishTemplate(templateId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["prompt_templates"] });
			queryClient.invalidateQueries({ queryKey: ["community_templates"] });
		},
	});
};

export const useToggleStar = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (templateId: string) => toggleTemplateStar(templateId),
		onMutate: async (templateId) => {
			// Optimistic update for stars cache
			await queryClient.cancelQueries({ queryKey: ["community_stars"] });
			const previousStars = queryClient.getQueryData<Set<string>>(["community_stars"]);

			queryClient.setQueryData<Set<string>>(["community_stars"], (old) => {
				const newSet = new Set(old);
				if (newSet.has(templateId)) {
					newSet.delete(templateId);
				} else {
					newSet.add(templateId);
				}
				return newSet;
			});

			return { previousStars };
		},
		onError: (_err, _templateId, context) => {
			if (context?.previousStars) {
				queryClient.setQueryData(["community_stars"], context.previousStars);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["community_stars"] });
			queryClient.invalidateQueries({ queryKey: ["community_templates"] });
			queryClient.invalidateQueries({ queryKey: ["prompt_template_ratings"] });
		},
	});
};

export const useCopyTemplate = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (templateId: string) => copyTemplate(templateId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["prompt_templates"] });
			queryClient.invalidateQueries({ queryKey: ["community_templates"] });
		},
	});
};
