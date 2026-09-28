import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import {
	createPromptTemplate,
	deletePromptTemplate,
	getPromptTemplates,
	getQuickAccessPreferences,
	type PromptTemplateResponse,
	type QuickAccessPreference,
	saveQuickAccessPreferences,
	toggleAiSuggestions,
	updatePromptTemplate,
} from "@/lib/api";

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
		onError: (error) => {
			void notifyError(error);
		},
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
		onError: (error) => {
			void notifyError(error);
		},
		onSuccess: async () => {
			await queryClient.refetchQueries({
				queryKey: ["prompt_templates", workspaceId ?? "__personal__"],
			});
			toast.success(t`Template updated`);
		},
	});
};

export const useDeleteUserTemplate = (workspaceId?: string | null) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => deletePromptTemplate(id),
		onError: (error) => {
			void notifyError(error);
		},
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
		onError: (
			_err,
			_vars,
			// Typed here: onError sorts before onMutate, which TanStack infers the context from.
			context: { previous?: unknown } | undefined,
		) => {
			if (context?.previous) {
				queryClient.setQueryData(
					["quick_access_preferences"],
					context.previous,
				);
			}
		},
		onMutate: async (newPreferences) => {
			await queryClient.cancelQueries({
				queryKey: ["quick_access_preferences"],
			});
			const previous = queryClient.getQueryData(["quick_access_preferences"]);
			queryClient.setQueryData(["quick_access_preferences"], newPreferences);
			return { previous };
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
		onError: (
			_err,
			_vars,
			// Typed here: onError sorts before onMutate, which TanStack infers the context from.
			context: { previous?: unknown } | undefined,
		) => {
			if (context?.previous) {
				queryClient.setQueryData(["users", "me"], context.previous);
			}
		},
		onMutate: async (hide) => {
			await queryClient.cancelQueries({ queryKey: ["users", "me"] });
			const previous = queryClient.getQueryData(["users", "me"]);
			queryClient.setQueryData(
				["users", "me"],
				(old: Record<string, unknown> | undefined) =>
					old ? { ...old, hide_ai_suggestions: hide } : old,
			);
			return { previous };
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
		},
	});
};
