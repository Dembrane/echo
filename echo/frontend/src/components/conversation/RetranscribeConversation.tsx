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
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import { ExponentialProgress } from "../common/ExponentialProgress";
import { useRetranscribeConversationMutation } from "./hooks";

export const RetranscribeConversationModalActionIcon = ({
	conversationId,
}: {
	conversationId: string;
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
				opened={opened}
				onClose={close}
			/>
		</>
	);
};

export const RetranscribeConversationModal = ({
	conversationId,
	opened,
	onClose,
}: {
	conversationId: string;
	opened: boolean;
	onClose: () => void;
}) => {
	const retranscribeMutation = useRetranscribeConversationMutation();

	const [newConversationName, setNewConversationName] = useState("");

	const handleRetranscribe = async () => {
		if (!conversationId || !newConversationName.trim()) return;
		await retranscribeMutation.mutateAsync({
			conversationId,
			newConversationName: newConversationName.trim(),
		});
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
