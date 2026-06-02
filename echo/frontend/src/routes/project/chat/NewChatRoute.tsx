import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Center,
	Group,
	Loader,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { formatRelative } from "date-fns";
import { Suspense, useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useParams } from "react-router";
import {
	ChatAccordionItemMenu,
	ChatModeIndicator,
} from "@/components/chat/ChatAccordion";
import { ChatModeSelector } from "@/components/chat/ChatModeSelector";
import { ChatSkeleton } from "@/components/chat/ChatSkeleton";
import {
	useInfiniteProjectChats,
	useInitializeChatModeMutation,
	usePrefetchSuggestions,
	useProjectChatsCount,
} from "@/components/chat/hooks";
import { NavigationButton } from "@/components/common/NavigationButton";
import { PageContainer } from "@/components/layout/PageContainer";
import { useCreateChatMutation } from "@/components/project/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import type { ChatMode } from "@/lib/api";

const CHATS_PAGE_SIZE = 10;

const ProjectChatsSection = ({
	projectId,
	workspaceId,
}: {
	projectId: string;
	workspaceId: string;
}) => {
	const { ref: loadMoreRef, inView } = useInView();
	const chatsCountQuery = useProjectChatsCount(projectId, undefined, {
		hasMessages: true,
	});
	const chatsQuery = useInfiniteProjectChats(projectId, undefined, {
		initialLimit: CHATS_PAGE_SIZE,
		hasMessages: true,
	});

	useEffect(() => {
		if (inView && chatsQuery.hasNextPage && !chatsQuery.isFetchingNextPage) {
			chatsQuery.fetchNextPage();
		}
	}, [
		inView,
		chatsQuery.hasNextPage,
		chatsQuery.isFetchingNextPage,
		chatsQuery.fetchNextPage,
	]);

	const totalChats = chatsCountQuery.data ?? 0;
	if (totalChats === 0) return null;

	const allChats =
		(
			chatsQuery.data?.pages as Array<{
				chats: ProjectChat[];
				nextOffset?: number;
			}>
		)?.flatMap((page) => page.chats) ?? [];

	return (
		<Stack gap="lg">
			<Group gap="sm" align="center">
				<Title order={2} fw={500} style={{ color: "var(--app-text)" }}>
					<Trans>Chats</Trans>
				</Title>
				<Badge variant="light">{totalChats}</Badge>
			</Group>

			<Stack gap="xs">
				{allChats.map((item, index) => {
					const chatMode = (item as ProjectChat & { chat_mode?: string })
						.chat_mode as
						| "overview"
						| "deep_dive"
						| "agentic"
						| null
						| undefined;
					return (
						<NavigationButton
							key={item.id}
							to={`/w/${workspaceId}/projects/${projectId}/chats/${item.id}`}
							rightSection={
								<Group gap="xs" wrap="nowrap">
									<ChatModeIndicator mode={chatMode} size="xs" />
									<ChatAccordionItemMenu chat={item as ProjectChat} />
								</Group>
							}
							ref={index === allChats.length - 1 ? loadMoreRef : undefined}
						>
							<Stack gap={2}>
								<Text size="sm" lineClamp={1}>
									{item.name
										? item.name
										: formatRelative(
												new Date(item.date_created ?? new Date()),
												new Date(),
											)}
								</Text>
								{item.name && (
									<Text size="xs" c="gray.6">
										{formatRelative(
											new Date(item.date_created ?? new Date()),
											new Date(),
										)}
									</Text>
								)}
							</Stack>
						</NavigationButton>
					);
				})}
				{chatsQuery.isFetchingNextPage && (
					<Center py="md">
						<Loader size="sm" />
					</Center>
				)}
			</Stack>
		</Stack>
	);
};

export const NewChatRoute = () => {
	useDocumentTitle(t`Ask | dembrane`);
	const { projectId, workspaceId } = useParams();
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

			// Step 3: For overview mode, prefetch suggestions (wait up to 5s for better UX)
			// For deep_dive mode, navigate immediately - suggestions will be fetched when context changes
			if (mode === "overview") {
				await prefetchSuggestions(chat.id, language, 5000);
			}

			// Step 4: Navigate to the new chat
			navigate(`/w/${workspaceId}/projects/${projectId}/chats/${chat.id}`);
		} catch (error) {
			console.error("Failed to create chat with mode:", error);
			setIsInitializing(false);
		}
	};

	if (!projectId || !workspaceId) {
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
		<PageContainer>
			<Stack gap="xl">
				<ChatModeSelector
					isNewChat
					isCreating={isPending}
					projectId={projectId}
					onModeSelected={handleModeSelected}
				/>

				<Suspense fallback={<ChatSkeleton />}>
					<ProjectChatsSection
						projectId={projectId}
						workspaceId={workspaceId}
					/>
				</Suspense>
			</Stack>
		</PageContainer>
	);
};

export default NewChatRoute;
