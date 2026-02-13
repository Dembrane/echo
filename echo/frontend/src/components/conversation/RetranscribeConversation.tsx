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
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { testId } from "@/lib/testUtils";
import { ExponentialProgress } from "../common/ExponentialProgress";
import { useProjectById } from "../project/hooks";
import { useRetranscribeConversationMutation } from "./hooks";

export const RetranscribeConversationModalActionIcon = ({
	conversationId,
	conversationName,
	disabled = false,
}: {
	conversationId: string;
	conversationName: string;
	disabled?: boolean;
}) => {
	const [opened, { open, close }] = useDisclosure(false);

	return (
		<>
			<Tooltip
				label={
					disabled
						? t`Retranscription not available for anonymized conversations`
						: t`Retranscribe conversation`
				}
			>
				<ActionIcon
					onClick={open}
					size="md"
					variant="subtle"
					color="gray"
					disabled={disabled}
					{...testId("transcript-retranscribe-button")}
				>
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

	const projectQuery = useProjectById({ projectId: projectId ?? "" });
	const projectAnonymize = projectQuery.data?.anonymize_transcripts ?? false;

	const retranscribeMutation = useRetranscribeConversationMutation();

	const [newConversationName, setNewConversationName] = useState(
		conversationName ?? "",
	);
	const [usePiiRedaction, setUsePiiRedaction] = useState(false);

	useEffect(() => {
		setUsePiiRedaction(projectAnonymize);
	}, [projectAnonymize]);

	const navigate = useI18nNavigate();

	const handleRetranscribe = async () => {
		if (!conversationId || !newConversationName.trim()) return;

		try {
			analytics.trackEvent(events.RETRANSCRIBE_CONVERSATION);
		} catch (error) {
			console.warn("Analytics tracking failed:", error);
		}

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
					<Badge color="mauve" c="graphite" size="sm">
						<Trans>Beta</Trans>
					</Badge>
				</Group>
			}
			{...testId("transcript-retranscribe-modal")}
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
						{...testId("transcript-retranscribe-name-input")}
					/>
					<Switch
						label={t`Use PII Redaction`}
						description={
							projectAnonymize
								? t`Project default: enabled. This will replace personally identifiable information with <redacted>.`
								: t`This will replace personally identifiable information with <redacted>.`
						}
						checked={usePiiRedaction}
						onChange={(e) => setUsePiiRedaction(e.currentTarget.checked)}
						{...testId("transcript-retranscribe-pii-toggle")}
					/>
					<Button
						onClick={handleRetranscribe}
						rightSection={<IconRefresh size="1rem" />}
						disabled={!newConversationName.trim()}
						{...testId("transcript-retranscribe-confirm-button")}
					>
						<Trans>Retranscribe</Trans>
					</Button>
				</Stack>
			)}
		</Modal>
	);
};
