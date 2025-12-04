import { Trans } from "@lingui/react/macro";
import { Box, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useParams } from "react-router";
import { ChatModeSelector } from "@/components/chat/ChatModeSelector";
import { useInitializeChatModeMutation, usePrefetchSuggestions } from "@/components/chat/hooks";
import { useCreateChatMutation } from "@/components/project/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import type { ChatMode } from "@/lib/api";

export const NewChatRoute = () => {
	const { projectId } = useParams();
	const navigate = useI18nNavigate();
	const { language } = useLanguage();
	const createChatMutation = useCreateChatMutation();
	const initializeModeMutation = useInitializeChatModeMutation();
	const prefetchSuggestions = usePrefetchSuggestions();
	const [isInitializing, setIsInitializing] = useState(false);

	const handleModeSelected = async (mode: ChatMode) => {
		if (!projectId) return;

		setIsInitializing(true);

		try {
			// Step 1: Create the chat without mode
			const chat = await createChatMutation.mutateAsync({
				navigateToNewChat: false, // Don't navigate yet
				project_id: { id: projectId },
			});

			if (!chat?.id) {
				throw new Error("Failed to create chat");
			}

			// Step 2: Initialize the mode (this attaches conversations for overview mode)
			await initializeModeMutation.mutateAsync({
				chatId: chat.id,
				mode,
				projectId,
			});

			// Step 3: Prefetch suggestions (wait up to 8s for better UX)
			// This ensures suggestions are ready when user lands on the chat
			await prefetchSuggestions(chat.id, language, 8000);

			// Step 4: Navigate to the new chat
			navigate(`/projects/${projectId}/chats/${chat.id}`);
		} catch (error) {
			console.error("Failed to create chat with mode:", error);
			setIsInitializing(false);
		}
	};

	if (!projectId) {
		return (
			<Box className="flex h-full items-center justify-center">
				<Text c="dimmed">
					<Trans>Project not found</Trans>
				</Text>
			</Box>
		);
	}

	const isPending =
		isInitializing ||
		createChatMutation.isPending ||
		initializeModeMutation.isPending;

	return (
		<Stack className="flex min-h-full items-center justify-center px-2 pr-4">
			<ChatModeSelector
				isNewChat
				isCreating={isPending}
				projectId={projectId}
				onModeSelected={handleModeSelected}
			/>
		</Stack>
	);
};

export default NewChatRoute;

