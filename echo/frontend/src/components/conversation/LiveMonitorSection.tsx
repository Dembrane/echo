import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
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
						) : (
							<Badge size="xs" color="gray" variant="light">
								<Trans>Idle</Trans>
							</Badge>
						)}
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
						<Trans>{conversation.chunk_count} recordings</Trans>
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
}: {
	projectId: string;
}) => {
	const { conversations, summary } = useConversationMonitor(projectId);

	// Nothing recent to monitor — stay out of the way.
	if (summary.total === 0) return null;

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
						<Trans>{summary.live} live</Trans>
					</Badge>
					{summary.with_errors > 0 && (
						<Badge size="sm" color="red" variant="light">
							<Trans>{summary.with_errors} with errors</Trans>
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
