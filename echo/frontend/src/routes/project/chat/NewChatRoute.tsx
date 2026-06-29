import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Badge,
	Box,
	Center,
	Group,
	Loader,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { IconAlertCircle } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import posthog from "posthog-js";
import { Suspense, useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useParams } from "react-router";
import {
	ChatAccordionItemMenu,
	ChatModeIndicator,
} from "@/components/chat/ChatAccordion";
import { ChatModeSelector } from "@/components/chat/ChatModeSelector";
import { ChatUpgradeModal } from "@/components/chat/FreeTierChatGate";
import {
	useInfiniteProjectChats,
	useInitializeChatModeMutation,
	usePrefetchSuggestions,
	useProjectChatsCount,
} from "@/components/chat/hooks";
import { BaseSkeleton } from "@/components/common/BaseSkeleton";
import { NavigationButton } from "@/components/common/NavigationButton";
import { PageContainer } from "@/components/layout/PageContainer";
import { useCreateChatMutation } from "@/components/project/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
import type { ChatMode } from "@/lib/api";
import { isFreeTierLimitError } from "@/lib/freeTier";
import { isReadOnlyRole } from "@/lib/roles";

const CHATS_PAGE_SIZE = 10;

// Standalone fallback: ChatSkeleton renders a bare Accordion.Item and
// throws when mounted outside an <Accordion>.
const ChatsSectionSkeleton = () => (
	<Stack gap="lg">
		<BaseSkeleton width="120px" height="28px" radius="xs" />
		<BaseSkeleton count={3} height="40px" width="100%" radius="xs" />
	</Stack>
);

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
		hasMessages: true,
		initialLimit: CHATS_PAGE_SIZE,
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
	const { workspace } = useWorkspace();
	// Observers can't chat; gate before the chat-list section mounts, since its
	// queries 403 and otherwise surface as "Something went wrong".
	const isObserver = isReadOnlyRole(workspace?.role);
	const { language } = useLanguage();
	const createChatMutation = useCreateChatMutation();
	const initializeModeMutation = useInitializeChatModeMutation();
	const prefetchSuggestions = usePrefetchSuggestions();
	const [isInitializing, setIsInitializing] = useState(false);
	const { freeTier } = useWorkspaceUsage(workspaceId);
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);
	const atChatLimit = Boolean(
		freeTier?.active && freeTier.chats_used >= freeTier.chats_limit,
	);

	const handleModeSelected = async (mode: ChatMode) => {
		if (!projectId) return;

		// Free tier: one chat per workspace. Route to upgrade instead of creating.
		if (atChatLimit) {
			upgradeHandlers.open();
			return;
		}

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

			posthog.capture("chat_started", {
				chat_id: chat.id,
				mode,
				project_id: projectId,
			});

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
			// Backend safety net: free-tier chat cap returns 402.
			if (isFreeTierLimitError(error) === "chats") {
				upgradeHandlers.open();
			} else {
				console.error("Failed to create chat with mode:", error);
			}
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

	// Observer read-only wall: no chat. Gate before the chat-list section mounts.
	if (isObserver) {
		return (
			<Box className="flex min-h-full items-center justify-center px-2 pr-4">
				<Alert
					icon={<IconAlertCircle size="1rem" />}
					color="primary"
					variant="light"
					maw={420}
				>
					<Text size="sm">
						<Trans>
							Chat isn't available on your access level. Reach out to your
							workspace admin to request an upgrade.
						</Trans>
					</Text>
				</Alert>
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
				atChatLimit={atChatLimit}
			/>

				<Suspense fallback={<ChatsSectionSkeleton />}>
					<ProjectChatsSection
						projectId={projectId}
						workspaceId={workspaceId}
					/>
				</Suspense>
			</Stack>
			<ChatUpgradeModal
				opened={upgradeOpened}
				onClose={upgradeHandlers.close}
				reason="chats"
			/>
		</PageContainer>
	);
};

export default NewChatRoute;
