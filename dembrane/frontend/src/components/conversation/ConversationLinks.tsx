import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Modal,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";

const MAX_VISIBLE_CONVERSATIONS = 3;

type ConversationListProps = {
	conversations: Conversation[];
	projectId: string;
	onItemClick?: () => void;
};

const ConversationList = ({
	conversations,
	projectId,
	onItemClick,
}: ConversationListProps) => {
	const { workspaceId } = useParams();
	return (
		<Stack gap="xs">
			{conversations.map((conversation, index) => (
				<I18nLink
					key={conversation.id}
					to={`/w/${workspaceId}/projects/${projectId}/conversations/${conversation.id}`}
					onClick={onItemClick}
					className="app-do block px-3 py-2 no-underline"
				>
					<Group gap="sm" wrap="nowrap">
						<Text size="xs" c="dimmed" className="min-w-8 tabular-nums">
							{index + 1}.
						</Text>
						<Text size="sm" className="flex-1 break-words">
							{conversation.participant_name}
						</Text>
					</Group>
				</I18nLink>
			))}
		</Stack>
	);
};

type ConversationsModalProps = {
	opened: boolean;
	onClose: () => void;
	conversations: Conversation[];
	projectId: string;
	totalCount: number;
};

const ConversationsModal = ({
	opened,
	onClose,
	conversations,
	projectId,
	totalCount,
}: ConversationsModalProps) => (
	<Modal
		opened={opened}
		onClose={onClose}
		title={
			<Group gap="sm" align="center">
				<Text size="lg">
					<Trans>All conversations</Trans>
				</Text>
				<Badge size="lg" color="gray">
					{totalCount}
				</Badge>
			</Group>
		}
		size="md"
		centered
	>
		<Stack gap="md">
			<Divider />
			<ScrollArea.Autosize mah={500} type="auto">
				<ConversationList
					conversations={conversations}
					projectId={projectId}
					onItemClick={onClose}
				/>
			</ScrollArea.Autosize>
			<Divider />
			<Group justify="flex-start">
				<Button
					variant="subtle"
					color="gray"
					onClick={onClose}
					leftSection={<XIcon size={20} />}
				>
					<Trans>Close</Trans>
				</Button>
			</Group>
		</Stack>
	</Modal>
);

export const ConversationLinks = ({
	conversations,
}: {
	conversations: Conversation[];
	color?: string;
	hoverUnderlineColor?: string;
}) => {
	const { projectId, workspaceId } = useParams();
	const [modalOpened, setModalOpened] = useState(false);

	// an error could occur if the conversation is deleted and not filtered in ChatHistoryMessage.tsx
	if (!conversations || conversations.length === 0) {
		return null;
	}

	const totalCount = conversations.length;
	const shouldCondense = totalCount > MAX_VISIBLE_CONVERSATIONS;
	const visibleConversations = shouldCondense
		? conversations.slice(0, MAX_VISIBLE_CONVERSATIONS)
		: conversations;
	const hiddenCount = totalCount - MAX_VISIBLE_CONVERSATIONS;

	// Always show conversation names (if 3 or fewer, show all; otherwise show first 3 + badge)
	return (
		<>
			<Group gap="sm" align="center" wrap="wrap">
				{visibleConversations.map((conversation) => (
					<I18nLink
						key={conversation.id}
						to={`/w/${workspaceId}/projects/${projectId}/conversations/${conversation.id}`}
					>
						<Box maw={300} className="cursor-pointer hover:underline">
							<Text size="xs" truncate="end">
								{conversation.participant_name}
							</Text>
						</Box>
					</I18nLink>
				))}

				{shouldCondense && (
					<Tooltip
						label={t`Click to see all ${totalCount} conversations`}
						position="top"
						withArrow
					>
						<Badge
							component="button"
							type="button"
							size="md"
							color="gray"
							ml="xs"
							onClick={() => setModalOpened(true)}
						>
							+
							<Plural
								value={hiddenCount}
								one="# conversation"
								other="# conversations"
							/>
						</Badge>
					</Tooltip>
				)}
			</Group>
			{shouldCondense && (
				<ConversationsModal
					opened={modalOpened}
					onClose={() => setModalOpened(false)}
					conversations={conversations}
					projectId={projectId ?? ""}
					totalCount={totalCount}
				/>
			)}
		</>
	);
};
