import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createPromptTemplate,
	deletePromptTemplate,
	deletePromptTemplateRating,
	getMyRatings,
	getQuickAccessPreferences,
	getPromptTemplates,
	type PromptTemplateResponse,
	ratePromptTemplate,
	saveQuickAccessPreferences,
	toggleAiSuggestions,
	updatePromptTemplate,
} from "@/lib/api";

// ── Prompt Templates CRUD ──

export const useUserTemplates = () => {
	return useQuery({
		queryFn: getPromptTemplates,
		queryKey: ["prompt_templates"],
	});
};

export const useCreateUserTemplate = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			title: string;
			content: string;
			icon?: string | null;
		}) => createPromptTemplate(payload),
		onSuccess: async (newTemplate) => {
			// Optimistically add the new template to the cache for instant UI feedback
			queryClient.setQueryData<PromptTemplateResponse[]>(
				["prompt_templates"],
				(old) => (old ? [...old, newTemplate] : [newTemplate]),
			);
			// Force refetch to get the canonical data from the server
			await queryClient.refetchQueries({ queryKey: ["prompt_templates"] });
		},
	});
};

export const useUpdateUserTemplate = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			id: string;
			title?: string;
			content?: string;
			icon?: string | null;
		}) => {
			const { id, ...data } = payload;
			return updatePromptTemplate(id, data);
		},
		onSuccess: async () => {
			await queryClient.refetchQueries({ queryKey: ["prompt_templates"] });
		},
	});
};

export const useDeleteUserTemplate = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => deletePromptTemplate(id),
		onSuccess: async (_, deletedId) => {
			// Remove immediately from cache
			queryClient.setQueryData<PromptTemplateResponse[]>(
				["prompt_templates"],
				(old) => old?.filter((t) => t.id !== deletedId) ?? [],
			);
			queryClient.invalidateQueries({ queryKey: ["prompt_template_preferences"] });
			await queryClient.refetchQueries({ queryKey: ["prompt_templates"] });
		},
	});
};

// ── Quick-Access Preferences ──

export const useQuickAccessPreferences = () => {
	return useQuery({
		queryFn: getQuickAccessPreferences,
		queryKey: ["prompt_template_preferences"],
	});
};

export const useSaveQuickAccessPreferences = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (
			preferences: Array<{
				template_type: "static" | "user";
				static_template_id?: string | null;
				prompt_template_id?: string | null;
				sort: number;
			}>,
		) => saveQuickAccessPreferences(preferences),
		onMutate: async (newPreferences) => {
			await queryClient.cancelQueries({
				queryKey: ["prompt_template_preferences"],
			});
			const previous = queryClient.getQueryData(["prompt_template_preferences"]);
			queryClient.setQueryData(
				["prompt_template_preferences"],
				newPreferences.map((p, i) => ({
					id: `optimistic-${i}`,
					template_type: p.template_type,
					static_template_id: p.static_template_id ?? null,
					prompt_template_id: p.prompt_template_id ?? null,
					sort: p.sort,
				})),
			);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					["prompt_template_preferences"],
					context.previous,
				);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: ["prompt_template_preferences"],
			});
		},
	});
};

// ── Ratings ──

export const useMyRatings = () => {
	return useQuery({
		queryFn: getMyRatings,
		queryKey: ["prompt_template_ratings"],
	});
};

export const useRatePromptTemplate = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			prompt_template_id: string;
			rating: 1 | 2;
			chat_message_id?: string | null;
		}) => ratePromptTemplate(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["prompt_template_ratings"],
			});
		},
	});
};

export const useDeleteRating = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (ratingId: string) => deletePromptTemplateRating(ratingId),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["prompt_template_ratings"],
			});
		},
	});
};

// ── AI Suggestions Toggle ──

export const useToggleAiSuggestions = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (hide: boolean) => toggleAiSuggestions(hide),
		onMutate: async (hide) => {
			await queryClient.cancelQueries({ queryKey: ["users", "me"] });
			const previous = queryClient.getQueryData(["users", "me"]);
			queryClient.setQueryData(["users", "me"], (old: Record<string, unknown> | undefined) =>
				old ? { ...old, hide_ai_suggestions: hide } : old,
			);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(["users", "me"], context.previous);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
		},
	});
};
