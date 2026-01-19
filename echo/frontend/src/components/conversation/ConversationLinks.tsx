import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
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
import { IconX } from "@tabler/icons-react";
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
}: ConversationListProps) => (
	<Stack gap={4}>
		{conversations.map((conversation, index) => (
			<I18nLink
				key={conversation.id}
				to={`/projects/${projectId}/conversation/${conversation.id}/overview`}
				onClick={onItemClick}
			>
				<Box className="cursor-pointer rounded-lg px-3.5 py-2.5 hover:bg-primary-100">
					<Group gap="sm" wrap="nowrap">
						<Text
							size="xs"
							c="dimmed"
							fw={500}
							className="min-w-8 tabular-nums"
						>
							{index + 1}.
						</Text>
						<Text size="sm" fw={500} className="flex-1 break-words">
							{conversation.participant_name}
						</Text>
					</Group>
				</Box>
			</I18nLink>
		))}
	</Stack>
);

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
				<Text fw={600} size="lg" style={{ color: "var(--app-text)" }}>
					<Trans>All Conversations</Trans>
				</Text>
				<Badge size="lg" variant="light">
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
			<Group justify="flex-end">
				<Button
					variant="light"
					onClick={onClose}
					leftSection={<IconX size={16} />}
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
	const { projectId } = useParams();
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
						to={`/projects/${projectId}/conversation/${conversation.id}/overview`}
					>
						<Box maw={300} className="cursor-pointer hover:underline">
							<Text size="xs" truncate="end" c="gray.7" pr={3}>
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
							size="md"
							variant="light"
							ml="xs"
							className="cursor-pointer not-italic"
							onClick={() => setModalOpened(true)}
						>
							<Trans>+{hiddenCount} conversations</Trans>
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
