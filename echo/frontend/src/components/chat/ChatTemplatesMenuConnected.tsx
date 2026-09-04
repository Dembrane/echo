import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { useProjectById } from "@/components/project/hooks";
import { useLanguage } from "@/hooks/useLanguage";
import type { ChatMode } from "@/lib/api";
import { ChatTemplatesMenu } from "./ChatTemplatesMenu";
import { useChatSuggestions, useProjectChatContext } from "./hooks";
import {
	useCreateUserTemplate,
	useDeleteUserTemplate,
	useQuickAccessPreferences,
	useSaveQuickAccessPreferences,
	useToggleAiSuggestions,
	useUpdateUserTemplate,
	useUserTemplates,
} from "./hooks/useUserTemplates";
import type { QuickAccessItem } from "./templateKey";
import { agenticQuickAccessTemplates, Templates } from "./templates";

/** Shared hook wiring for ChatTemplatesMenu so classic and agentic render it identically. */
export const ChatTemplatesMenuConnected = ({
	chatId,
	chatMode,
	projectId,
	selectedTemplateKey,
	externalOpen,
	onExternalClose,
	onTemplateSelect,
	saveAsTemplateContent,
	onClearSaveAsTemplate,
	refetchSuggestionsKey,
}: {
	chatId?: string;
	chatMode?: ChatMode | null;
	projectId?: string;
	selectedTemplateKey?: string | null;
	externalOpen?: boolean;
	onExternalClose?: () => void;
	onTemplateSelect: (args: { content: string; key: string }) => void;
	saveAsTemplateContent?: string | null;
	onClearSaveAsTemplate?: () => void;
	/** Change to trigger a suggestions refetch; omit to skip that behavior. */
	refetchSuggestionsKey?: unknown;
}) => {
	const { language } = useLanguage();
	const queryClient = useQueryClient();

	const chatContextQuery = useProjectChatContext(chatId ?? "");

	// Fetch the project's workspace_id so templates hook can return BOTH
	// personal (scope='user') and workspace-shared (scope='workspace')
	// templates for this workspace.
	const projectForWorkspace = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "workspace_id"] },
	});
	const projectWorkspaceId =
		(projectForWorkspace.data as { workspace_id?: string | null } | undefined)
			?.workspace_id ?? null;

	const currentUserQuery = useCurrentUser();
	const userTemplatesQuery = useUserTemplates(projectWorkspaceId);
	const createUserTemplateMutation = useCreateUserTemplate(projectWorkspaceId);
	const updateUserTemplateMutation = useUpdateUserTemplate(projectWorkspaceId);
	const deleteUserTemplateMutation = useDeleteUserTemplate(projectWorkspaceId);
	const quickAccessQuery = useQuickAccessPreferences();
	const saveQuickAccessMutation = useSaveQuickAccessPreferences();
	const toggleAiSuggestionsMutation = useToggleAiSuggestions();

	const hideAiSuggestions = currentUserQuery.data?.hide_ai_suggestions ?? false;

	// Resolve quick access items - default to first 3 built-in templates
	const quickAccessItems: QuickAccessItem[] = useMemo(() => {
		const isAgentic = chatMode === "agentic";
		const defaultTemplates = isAgentic ? agenticQuickAccessTemplates : Templates.slice(0, 3);
		if (!quickAccessQuery.data || quickAccessQuery.data.length === 0)
			return defaultTemplates.map((t) => ({
				id: t.id,
				title: t.title,
				type: "static" as const,
			}));
		return quickAccessQuery.data
			.map((pref) => {
				if (pref.type === "static") {
					const allStatics = [...Templates, ...agenticQuickAccessTemplates];
					const found = allStatics.find((t) => t.id === pref.id);
					if (found)
						return {
							id: found.id,
							title: found.title,
							type: "static" as const,
						};
				} else if (pref.type === "user") {
					const found = userTemplatesQuery.data?.find((t) => t.id === pref.id);
					if (found)
						return {
							id: found.id,
							title: found.title,
							type: "user" as const,
						};
				}
				return null;
			})
			.filter(Boolean) as QuickAccessItem[];
	}, [quickAccessQuery.data, userTemplatesQuery.data, chatMode]);

	const handleSaveQuickAccess = (items: QuickAccessItem[]) => {
		saveQuickAccessMutation.mutate(
			items.map((item) => ({
				id: item.id,
				type: item.type,
			})),
		);
	};

	const isModeSelected = chatMode !== null && chatMode !== undefined;
	const isDeepDiveMode = chatMode === "deep_dive";
	const isAgenticMode = chatMode === "agentic";
	const conversationCount = chatContextQuery.data?.conversations?.length ?? 0;
	const prevConversationCountRef = useRef<number | null>(null);

	// Fetch suggestions:
	// - Overview mode: Fetch immediately when mode is selected
	// - Deep dive mode: Only fetch after conversations are added (not on initial load)
	// - Agentic: never (isAgenticMode always excludes it)
	const shouldFetchSuggestions =
		isModeSelected &&
		!isAgenticMode &&
		!hideAiSuggestions &&
		(!isDeepDiveMode || conversationCount > 0);

	const suggestionsQuery = useChatSuggestions(chatId ?? "", {
		enabled: shouldFetchSuggestions,
		language,
	});

	// Refetch suggestions when conversation context changes in deep_dive mode.
	// Cancel previous query and start a new one.
	useEffect(() => {
		if (!isDeepDiveMode || !chatId) return;

		// Skip on initial mount
		if (prevConversationCountRef.current === null) {
			prevConversationCountRef.current = conversationCount;
			return;
		}

		// Only refetch if count actually changed
		if (prevConversationCountRef.current !== conversationCount) {
			prevConversationCountRef.current = conversationCount;

			queryClient.cancelQueries({
				queryKey: ["chats", chatId, "suggestions", language],
			});

			if (conversationCount > 0) {
				suggestionsQuery.refetch();
			}
		}
	}, [
		conversationCount,
		isDeepDiveMode,
		chatId,
		language,
		queryClient,
		suggestionsQuery,
	]);

	// Refetch suggestions when the caller signals the assistant just finished
	// responding (classic refetches on the isLoading -> false transition).
	const prevRefetchKeyRef = useRef<unknown>(refetchSuggestionsKey);
	const isFirstRefetchKeyRenderRef = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: suggestionsQuery identity changes per render; only refetchSuggestionsKey should retrigger this
	useEffect(() => {
		if (isFirstRefetchKeyRenderRef.current) {
			isFirstRefetchKeyRenderRef.current = false;
			prevRefetchKeyRef.current = refetchSuggestionsKey;
			return;
		}
		if (prevRefetchKeyRef.current !== refetchSuggestionsKey) {
			prevRefetchKeyRef.current = refetchSuggestionsKey;
			suggestionsQuery.refetch();
		}
	}, [refetchSuggestionsKey]);

	return (
		<ChatTemplatesMenu
			externalOpen={externalOpen}
			onExternalClose={onExternalClose}
			onTemplateSelect={onTemplateSelect}
			selectedTemplateKey={selectedTemplateKey}
			suggestions={hideAiSuggestions ? [] : suggestionsQuery.data?.suggestions}
			chatMode={chatMode}
			userTemplates={userTemplatesQuery.data ?? []}
			canCreateWorkspaceTemplate={Boolean(projectWorkspaceId)}
			onCreateUserTemplate={(payload) =>
				createUserTemplateMutation.mutateAsync(payload)
			}
			onUpdateUserTemplate={(payload) =>
				updateUserTemplateMutation.mutateAsync(payload)
			}
			onDeleteUserTemplate={(id) => deleteUserTemplateMutation.mutateAsync(id)}
			isCreatingTemplate={createUserTemplateMutation.isPending}
			isUpdatingTemplate={updateUserTemplateMutation.isPending}
			isDeletingTemplate={deleteUserTemplateMutation.isPending}
			quickAccessItems={quickAccessItems}
			onSaveQuickAccess={handleSaveQuickAccess}
			isSavingQuickAccess={saveQuickAccessMutation.isPending}
			hideAiSuggestions={hideAiSuggestions}
			onToggleAiSuggestions={(hide) => toggleAiSuggestionsMutation.mutate(hide)}
			saveAsTemplateContent={saveAsTemplateContent}
			onClearSaveAsTemplate={onClearSaveAsTemplate}
		/>
	);
};
