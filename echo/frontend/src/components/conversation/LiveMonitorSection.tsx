import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Badge, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import { BroadcastIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";

import {
	type MonitorConversation,
	useConversationMonitor,
} from "@/hooks/useConversationMonitor";

const LiveDot = () => (
	<span
		aria-hidden
		className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse"
	/>
);

const lastActivityLabel = (conversation: MonitorConversation): string => {
	if (!conversation.last_chunk_at) return t`No activity yet`;
	try {
		return formatDistanceToNow(new Date(conversation.last_chunk_at), {
			addSuffix: true,
		});
	} catch {
		return conversation.last_chunk_at;
	}
};

const TranscriptionBadge = ({
	conversation,
}: {
	conversation: MonitorConversation;
}) => {
	// A failing conversation already shows a red Error badge; don't double up.
	if (conversation.transcription_status === "failing") return null;

	if (conversation.transcription_status === "transcribing") {
		return (
			<Badge size="xs" color="blue" variant="light">
				<Plural
					value={conversation.pending_transcription}
					one="Transcribing # clip"
					other="Transcribing # clips"
				/>
			</Badge>
		);
	}

	if (
		conversation.transcription_status === "up_to_date" &&
		conversation.chunk_count > 0
	) {
		return (
			<Badge size="xs" color="green" variant="light">
				<Trans>Transcribed</Trans>
			</Badge>
		);
	}

	return null;
};

const MonitorRow = ({
	conversation,
}: {
	conversation: MonitorConversation;
}) => {
	const label = conversation.label?.trim() || t`Anonymous participant`;

	return (
		<Card withBorder p="sm" radius="sm">
			<Stack gap={6}>
				<Group justify="space-between" align="center" wrap="nowrap">
					<Group gap="xs" align="center" style={{ minWidth: 0 }}>
						{conversation.is_live && <LiveDot />}
						<Text size="sm" fw={500} truncate>
							{label}
						</Text>
					</Group>
					<Group gap="xs" align="center" wrap="nowrap">
						{conversation.is_live ? (
							<Badge size="xs" color="red" variant="light">
								<Trans>Live</Trans>
							</Badge>
						) : conversation.is_finished ? (
							<Badge size="xs" color="primary" variant="light">
								<Trans>Finished</Trans>
							</Badge>
						) : (
							<Badge size="xs" color="gray" variant="light">
								<Trans>Idle</Trans>
							</Badge>
						)}
						<TranscriptionBadge conversation={conversation} />
						{conversation.has_error && (
							<Badge
								size="xs"
								color="red"
								variant="filled"
								leftSection={<WarningCircleIcon size={12} />}
							>
								<Trans>Error</Trans>
							</Badge>
						)}
					</Group>
				</Group>

				<Group gap="md" align="center">
					<Text size="xs" c="dimmed">
						<Trans>Last activity {lastActivityLabel(conversation)}</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Plural
							value={conversation.chunk_count}
							one="# recording"
							other="# recordings"
						/>
					</Text>
				</Group>

				{conversation.has_error && conversation.error_message && (
					<Tooltip
						label={conversation.error_message}
						multiline
						maw={360}
						withArrow
					>
						<Text size="xs" c="red.7" lineClamp={2}>
							{conversation.error_message}
						</Text>
					</Tooltip>
				)}
			</Stack>
		</Card>
	);
};

export const LiveMonitorSection = ({
	projectId,
	standalone = false,
}: {
	projectId: string;
	/** On the dedicated Monitor page, show an empty state instead of
	 * collapsing to nothing when there is no recent activity. */
	standalone?: boolean;
}) => {
	const { conversations, summary } = useConversationMonitor(projectId);

	// Nothing recent to monitor. On the home page we stay out of the way; on the
	// dedicated Monitor page we explain what the host is looking at.
	if (summary.total === 0) {
		if (!standalone) return null;
		return (
			<Card withBorder p="lg" radius="sm">
				<Stack gap="xs" align="center">
					<BroadcastIcon size={24} />
					<Text size="sm" fw={500}>
						<Trans>No recent activity</Trans>
					</Text>
					<Text size="xs" c="dimmed" ta="center" maw={420}>
						<Trans>
							Live recordings, transcription progress, and errors show up here
							as participants start recording in the portal.
						</Trans>
					</Text>
				</Stack>
			</Card>
		);
	}

	return (
		<Stack gap="sm">
			<Group justify="space-between" align="center" gap="sm">
				<Group gap="xs" align="center">
					<BroadcastIcon size={16} />
					<Text size="xs" c="dimmed" tt="uppercase">
						<Trans>Live monitoring</Trans>
					</Text>
				</Group>
				<Group gap="xs" align="center">
					<Badge size="sm" color="primary" variant="light">
						<Plural value={summary.live} one="# live" other="# live" />
					</Badge>
					{summary.transcribing > 0 && (
						<Badge size="sm" color="blue" variant="light">
							<Plural
								value={summary.transcribing}
								one="# transcribing"
								other="# transcribing"
							/>
						</Badge>
					)}
					{summary.with_errors > 0 && (
						<Badge size="sm" color="red" variant="light">
							<Plural
								value={summary.with_errors}
								one="# with errors"
								other="# with errors"
							/>
						</Badge>
					)}
				</Group>
			</Group>

			<Stack gap="xs">
				{conversations.map((conversation) => (
					<MonitorRow key={conversation.id} conversation={conversation} />
				))}
			</Stack>
		</Stack>
	);
};
