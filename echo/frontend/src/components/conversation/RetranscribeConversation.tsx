import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Group,
	Modal,
	Stack,
	Switch,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { ExponentialProgress } from "../common/ExponentialProgress";
import { useRetranscribeConversationMutation } from "./hooks";

export const RetranscribeConversationModalActionIcon = ({
	conversationId,
	conversationName,
}: {
	conversationId: string;
	conversationName: string;
}) => {
	const [opened, { open, close }] = useDisclosure(false);

	return (
		<>
			<Tooltip label={t`Retranscribe conversation`}>
				<ActionIcon onClick={open} size="md" variant="subtle" color="gray">
					<IconRefresh size={20} />
				</ActionIcon>
			</Tooltip>

			<RetranscribeConversationModal
				conversationId={conversationId}
				conversationName={conversationName}
				opened={opened}
				onClose={close}
			/>
		</>
	);
};

export const RetranscribeConversationModal = ({
	conversationId,
	conversationName,
	opened,
	onClose,
}: {
	conversationId: string;
	conversationName: string;
	opened: boolean;
	onClose: () => void;
}) => {
	// this should rly be a prop im lazy
	const { projectId } = useParams();

	const retranscribeMutation = useRetranscribeConversationMutation();

	const [newConversationName, setNewConversationName] = useState(
		conversationName ?? "",
	);
	const [usePiiRedaction, setUsePiiRedaction] = useState(false);

	const navigate = useI18nNavigate();

	const handleRetranscribe = async () => {
		if (!conversationId || !newConversationName.trim()) return;
		const { new_conversation_id } = await retranscribeMutation.mutateAsync({
			conversationId,
			newConversationName: newConversationName.trim(),
			usePiiRedaction,
		});
		if (new_conversation_id) {
			onClose();
			toast.success(
				t`Retranscription started. New conversation will be available soon.`,
				{
					action: {
						actionButtonStyle: {
							color: "blue",
						},
						label: t`Go to new conversation`,
						onClick: () => {
							navigate(
								`/projects/${projectId}/conversation/${new_conversation_id}/transcript`,
							);
						},
					},
				},
			);
		}
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Group gap="xs">
					<Text>{t`Retranscribe Conversation`}</Text>
					<Badge color="blue" size="sm">
						<Trans>Experimental</Trans>
					</Badge>
				</Group>
			}
		>
			{retranscribeMutation.isPending ? (
				<Stack>
					<Alert title={t`Processing your retranscription request...`}>
						<Trans>
							Please wait while we process your retranscription request. You
							will be redirected to the new conversation when ready.
						</Trans>
					</Alert>
					<ExponentialProgress expectedDuration={30} isLoading={true} />
				</Stack>
			) : (
				<Stack>
					<Alert>
						<Trans>
							This will create a new conversation with the same audio but a
							fresh transcription. The original conversation will remain
							unchanged.
						</Trans>
					</Alert>
					<TextInput
						label={t`New Conversation Name`}
						placeholder={t`Enter a name for the new conversation`}
						value={newConversationName}
						onChange={(e) => setNewConversationName(e.currentTarget.value)}
						required
					/>
					<Switch
						label={t`Use PII Redaction`}
						description={t`This will replace personally identifiable information with <redacted>.`}
						checked={usePiiRedaction}
						onChange={(e) => setUsePiiRedaction(e.currentTarget.checked)}
					/>
					<Button
						onClick={handleRetranscribe}
						rightSection={<IconRefresh size="1rem" />}
						disabled={!newConversationName.trim()}
					>
						<Trans>Retranscribe</Trans>
					</Button>
				</Stack>
			)}
		</Modal>
	);
};
