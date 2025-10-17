import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	ActionIcon,
	Center,
	Group,
	Loader,
	Menu,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconDotsVertical, IconPencil, IconTrash } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import { Suspense, useEffect } from "react";
import { useInView } from "react-intersection-observer";
import { useParams } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { NavigationButton } from "../common/NavigationButton";
import { ChatSkeleton } from "./ChatSkeleton";
import {
	useDeleteChatMutation,
	useInfiniteProjectChats,
	useProjectChatsCount,
	useUpdateChatMutation,
} from "./hooks";

export const ChatAccordionItemMenu = ({
	chat,
	size = "sm",
}: {
	chat: Partial<ProjectChat>;
	size?: "sm" | "md";
}) => {
	const deleteChatMutation = useDeleteChatMutation();
	const updateChatMutation = useUpdateChatMutation();
	const navigate = useI18nNavigate();

	return (
		<Menu shadow="md" position="right">
			<Menu.Target>
				<ActionIcon
					variant="transparent"
					c="gray"
					size={size}
					className="flex items-center justify-center"
				>
					<IconDotsVertical />
				</ActionIcon>
			</Menu.Target>

			<Menu.Dropdown>
				<Stack gap="xs">
					<Menu.Item
						leftSection={<IconPencil />}
						disabled={deleteChatMutation.isPending}
						onClick={() => {
							const newName = prompt(
								t`Enter new name for the chat:`,
								chat.name ?? "",
							);
							if (newName) {
								updateChatMutation.mutate({
									chatId: chat.id ?? "",
									payload: { name: newName },
									projectId: (chat.project_id as string) ?? "",
								});
							}
						}}
					>
						<Trans id="project.sidebar.chat.rename">Rename</Trans>
					</Menu.Item>
					<Menu.Item
						leftSection={<IconTrash />}
						disabled={deleteChatMutation.isPending}
						onClick={() => {
							if (confirm("Are you sure you want to delete this chat?")) {
								deleteChatMutation.mutate({
									chatId: chat.id ?? "",
									projectId: (chat.project_id as string) ?? "",
								});
								navigate(`/projects/${chat.project_id}/overview`);
							}
						}}
					>
						<Trans id="project.sidebar.chat.delete">Delete</Trans>
					</Menu.Item>
				</Stack>
			</Menu.Dropdown>
		</Menu>
	);
};

// Chat Accordion
export const ChatAccordionMain = ({ projectId }: { projectId: string }) => {
	const { chatId: activeChatId } = useParams();
	const { ref: loadMoreRef, inView } = useInView();

	const chatsQuery = useInfiniteProjectChats(
		projectId,
		{
			filter: {
				_or: [
					// @ts-expect-error
					...(activeChatId
						? [
								{
									id: {
										_eq: activeChatId,
									},
								},
							]
						: []),
					// @ts-expect-error
					{
						"count(project_chat_messages)": {
							_gt: 0,
						},
					},
				],
				project_id: {
					_eq: projectId,
				},
			},
		},
		{
			initialLimit: 15,
		},
	);

	// Get total count of chats for display
	const chatsCountQuery = useProjectChatsCount(projectId, {
		filter: {
			_or: [
				// @ts-expect-error
				...(activeChatId
					? [
							{
								id: {
									_eq: activeChatId,
								},
							},
						]
					: []),
				// @ts-expect-error
				{
					"count(project_chat_messages)": {
						_gt: 0,
					},
				},
			],
			project_id: {
				_eq: projectId,
			},
		},
	});

	// Load more chats when user scrolls to bottom
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

	// Flatten all chats from all pages
	const allChats =
		(
			chatsQuery.data?.pages as Array<{
				chats: ProjectChat[];
				nextOffset?: number;
			}>
		)?.flatMap((page) => page.chats) ?? [];
	const totalChats = Number(chatsCountQuery.data) ?? 0;

	return (
		<Accordion.Item value="chat">
			<Accordion.Control>
				<Group justify="space-between">
					<Title order={3}>
						<span className="min-w-[48px] pr-2 font-normal text-gray-500">
							{totalChats}
						</span>
						<Trans id="project.sidebar.chat.title">Chats</Trans>
					</Title>
				</Group>
			</Accordion.Control>

			<Accordion.Panel>
				<Stack gap="xs">
					{totalChats === 0 && (
						<Text size="sm">
							<Trans id="project.sidebar.chat.empty.description">
								No chats found. Start a chat using the "Ask" button.
							</Trans>
						</Text>
					)}
					{allChats.map((item, index) => (
						<NavigationButton
							key={item.id}
							to={`/projects/${projectId}/chats/${item.id}`}
							active={item.id === activeChatId}
							rightSection={
								<ChatAccordionItemMenu chat={item as ProjectChat} />
							}
							ref={index === allChats.length - 1 ? loadMoreRef : undefined}
						>
							<Stack gap="xs">
								<Text size="sm">
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
					))}
					{chatsQuery.isFetchingNextPage && (
						<Center py="md">
							<Loader size="sm" />
						</Center>
					)}
					{/* {!chatsQuery.hasNextPage && allChats.length > 0 && (
            <Center py="md">
              <Text size="xs" c="dimmed" ta="center" fs="italic">
                <Trans id="project.sidebar.chat.end.description">
                  End of list • All {totalChats} chats loaded
                </Trans>
              </Text>
            </Center>
          )} */}
				</Stack>
			</Accordion.Panel>
		</Accordion.Item>
	);
};

export const ChatAccordion = ({ projectId }: { projectId: string }) => {
	return (
		<Suspense fallback={<ChatSkeleton />}>
			<ChatAccordionMain projectId={projectId} />
		</Suspense>
	);
};
