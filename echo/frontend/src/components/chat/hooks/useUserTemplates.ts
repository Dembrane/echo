import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createPromptTemplate,
	deletePromptTemplate,
	getQuickAccessPreferences,
	getPromptTemplates,
	type PromptTemplateResponse,
	type QuickAccessPreference,
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
			queryClient.invalidateQueries({ queryKey: ["quick_access_preferences"] });
			await queryClient.refetchQueries({ queryKey: ["prompt_templates"] });
		},
	});
};

// ── Quick-Access Preferences ──

export const useQuickAccessPreferences = () => {
	return useQuery({
		queryFn: getQuickAccessPreferences,
		queryKey: ["quick_access_preferences"],
	});
};

export const useSaveQuickAccessPreferences = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (preferences: QuickAccessPreference[]) =>
			saveQuickAccessPreferences(preferences),
		onMutate: async (newPreferences) => {
			await queryClient.cancelQueries({
				queryKey: ["quick_access_preferences"],
			});
			const previous = queryClient.getQueryData(["quick_access_preferences"]);
			queryClient.setQueryData(["quick_access_preferences"], newPreferences);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					["quick_access_preferences"],
					context.previous,
				);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: ["quick_access_preferences"],
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
