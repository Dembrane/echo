import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AxiosError } from "axios";
import { t } from "@lingui/core/macro";

import { toast } from "@/components/common/Toaster";
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

// Prefer the backend's error detail; fall back to a generic message.
const templateError = (error: unknown, fallback: string): string =>
	(error as AxiosError<{ detail?: string }>)?.response?.data?.detail ?? fallback;

// ── Prompt Templates CRUD ──

export const useUserTemplates = (workspaceId?: string | null) => {
	return useQuery({
		queryFn: () => getPromptTemplates(workspaceId),
		queryKey: ["prompt_templates", workspaceId ?? "__personal__"],
	});
};

export const useCreateUserTemplate = (workspaceId?: string | null) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			title: string;
			content: string;
			icon?: string | null;
			scope?: "user" | "workspace";
		}) =>
			createPromptTemplate({
				...payload,
				workspace_id: payload.scope === "workspace" ? workspaceId : null,
			}),
		onSuccess: async (newTemplate) => {
			queryClient.setQueryData<PromptTemplateResponse[]>(
				["prompt_templates", workspaceId ?? "__personal__"],
				(old) => (old ? [...old, newTemplate] : [newTemplate]),
			);
			await queryClient.refetchQueries({
				queryKey: ["prompt_templates", workspaceId ?? "__personal__"],
			});
			toast.success(t`Template created`);
		},
		onError: (error) => {
			toast.error(templateError(error, t`Could not create template`));
		},
	});
};

export const useUpdateUserTemplate = (workspaceId?: string | null) => {
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
			await queryClient.refetchQueries({
				queryKey: ["prompt_templates", workspaceId ?? "__personal__"],
			});
			toast.success(t`Template updated`);
		},
		onError: (error) => {
			toast.error(templateError(error, t`Could not update template`));
		},
	});
};

export const useDeleteUserTemplate = (workspaceId?: string | null) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => deletePromptTemplate(id),
		onSuccess: async (_, deletedId) => {
			queryClient.setQueryData<PromptTemplateResponse[]>(
				["prompt_templates", workspaceId ?? "__personal__"],
				(old) => old?.filter((tmpl) => tmpl.id !== deletedId) ?? [],
			);
			queryClient.invalidateQueries({ queryKey: ["quick_access_preferences"] });
			await queryClient.refetchQueries({
				queryKey: ["prompt_templates", workspaceId ?? "__personal__"],
			});
			toast.success(t`Template deleted`);
		},
		onError: (error) => {
			toast.error(templateError(error, t`Could not delete template`));
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
