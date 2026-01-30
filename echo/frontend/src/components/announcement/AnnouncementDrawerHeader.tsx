import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Button, Group, Stack, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { testId } from "@/lib/testUtils";
import { useUnreadAnnouncements } from "./hooks";

export const AnnouncementDrawerHeader = ({
	onClose,
	onMarkAllAsRead,
	isPending,
}: {
	onClose: () => void;
	onMarkAllAsRead: () => void;
	isPending: boolean;
}) => {
	const { data: unreadCount } = useUnreadAnnouncements();
	const hasUnreadAnnouncements = unreadCount && unreadCount > 0;

	return (
		<Stack justify="space-between" align="flex-start" gap="xs">
			<Group justify="space-between" align="center" w="100%">
				<Text fw={500} size="lg">
					<Trans>Announcements</Trans>
				</Text>
				<ActionIcon
					variant="transparent"
					onClick={onClose}
					aria-label="Close drawer"
					className="focus:outline-none"
					{...testId("announcement-close-drawer-button")}
				>
					<IconX color="gray" />
				</ActionIcon>
			</Group>
			<Group gap="xs" justify="space-between" w="100%">
				{hasUnreadAnnouncements && (
					<Text size="sm" c="dimmed" {...testId("announcement-unread-count")}>
						{unreadCount}{" "}
						{unreadCount === 1
							? t`unread announcement`
							: t`unread announcements`}
					</Text>
				)}
				{hasUnreadAnnouncements && (
					<Button
						variant="subtle"
						size="xs"
						onClick={onMarkAllAsRead}
						disabled={isPending}
						loading={isPending}
						{...testId("announcement-mark-all-read-button")}
					>
						<Trans>Mark all read</Trans>
					</Button>
				)}
			</Group>
		</Stack>
	);
};
