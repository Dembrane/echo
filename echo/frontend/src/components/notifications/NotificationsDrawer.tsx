import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Avatar,
	Badge,
	Box,
	Button,
	Center,
	Drawer,
	Group,
	Indicator,
	Loader,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconBell, IconCheck } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import {
	resolveNotificationHref,
	useMarkAllNotificationsRead,
	useMarkNotificationRead,
	useNotifications,
	useUnreadNotificationCount,
	type NotificationRow,
} from "@/hooks/useNotifications";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

/**
 * Inbox entry point in the header. Icon with an unread badge; clicking
 * opens a right-side drawer of per-user notifications.
 *
 * Sibling of the existing `AnnouncementIcon`. The user's designer has
 * mocked a consolidated "Inbox" that merges both — when that design
 * ships, these two icons collapse into one. For now they live as
 * separate adjacent icons so notifications can ship without blocking
 * on the consolidation.
 */
export const NotificationsDrawer = () => {
	const [opened, { open, close }] = useDisclosure(false);
	const navigate = useI18nNavigate();
	const { data: notifications = [], isLoading } = useNotifications();
	const { data: unreadCount = 0 } = useUnreadNotificationCount();
	const markRead = useMarkNotificationRead();
	const markAllRead = useMarkAllNotificationsRead();

	const handleClick = (row: NotificationRow) => {
		// Flip read state optimistically via the mutation, then resolve the
		// action into a URL. Static copy ("NONE") notifications stay put.
		if (!row.read) {
			markRead.mutate(row.id);
		}
		const href = resolveNotificationHref(row);
		if (href) {
			navigate(href);
			close();
		}
	};

	return (
		<>
			<Indicator
				inline
				size={18}
				offset={4}
				color="primary"
				label={unreadCount > 0 ? unreadCount : undefined}
				disabled={unreadCount === 0}
				withBorder
			>
				<ActionIcon
					variant="transparent"
					onClick={open}
					aria-label={t`Notifications`}
				>
					<IconBell size={22} />
				</ActionIcon>
			</Indicator>

			<Drawer
				opened={opened}
				onClose={close}
				position="right"
				padding="lg"
				size="sm"
				title={
					<Group gap="sm" justify="space-between" w="100%">
						<Text fw={500}>
							<Trans>Notifications</Trans>
						</Text>
						{unreadCount > 0 && (
							<Button
								variant="subtle"
								size="compact-xs"
								leftSection={<IconCheck size={12} />}
								onClick={() => markAllRead.mutate()}
								loading={markAllRead.isPending}
							>
								<Trans>Mark all read</Trans>
							</Button>
						)}
					</Group>
				}
			>
				{isLoading ? (
					<Center py="xl">
						<Loader size="sm" color="gray" />
					</Center>
				) : notifications.length === 0 ? (
					<Center py="xl">
						<Stack align="center" gap={4}>
							<IconBell size={28} color="var(--mantine-color-gray-5)" />
							<Text size="sm" c="dimmed" ta="center">
								<Trans>You're all caught up.</Trans>
							</Text>
						</Stack>
					</Center>
				) : (
					<Stack gap={0}>
						{notifications.map((row) => (
							<NotificationItem
								key={row.id}
								row={row}
								onClick={() => handleClick(row)}
							/>
						))}
					</Stack>
				)}
			</Drawer>
		</>
	);
};

function NotificationItem({
	row,
	onClick,
}: {
	row: NotificationRow;
	onClick: () => void;
}) {
	const title = row.translation?.title ?? row.event_code;
	const message = row.translation?.message ?? "";
	const hasAction = resolveNotificationHref(row) !== null;
	const createdLabel = row.created_at
		? formatRelative(new Date(row.created_at), new Date())
		: "";

	return (
		<UnstyledButton
			onClick={onClick}
			disabled={!hasAction}
			style={{
				display: "block",
				padding: "12px 4px",
				borderBottom: "1px solid var(--mantine-color-gray-2)",
				cursor: hasAction ? "pointer" : "default",
				background: row.read
					? "transparent"
					: "rgba(65,105,225,0.03)",
			}}
		>
			<Group gap="sm" wrap="nowrap" align="flex-start">
				{/* Actor avatar when available; otherwise level-coloured dot
				    so the row still has a visual anchor. */}
				{row.actor_user_id ? (
					<Avatar
						src={row.actor_avatar ?? undefined}
						size="sm"
						radius="xl"
					>
						{(row.actor_name || "?").slice(0, 2).toUpperCase()}
					</Avatar>
				) : (
					<Box
						style={{
							width: 28,
							height: 28,
							borderRadius: "50%",
							background:
								row.level === "urgent"
									? "var(--mantine-color-red-1)"
									: "var(--mantine-color-blue-1)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							flexShrink: 0,
						}}
					>
						<IconBell
							size={14}
							color={
								row.level === "urgent"
									? "var(--mantine-color-red-7)"
									: "var(--mantine-color-blue-7)"
							}
						/>
					</Box>
				)}

				<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
					<Group gap="xs" align="center" wrap="nowrap">
						<Text size="sm" fw={row.read ? 400 : 500} lineClamp={1}>
							{title}
						</Text>
						{!row.read && (
							<Box
								style={{
									width: 6,
									height: 6,
									borderRadius: "50%",
									background: "var(--mantine-color-blue-6)",
									flexShrink: 0,
								}}
								aria-label={t`Unread`}
							/>
						)}
						{row.level === "urgent" && (
							<Badge size="xs" color="red" variant="light">
								<Trans>Urgent</Trans>
							</Badge>
						)}
					</Group>
					{message && (
						<Text size="xs" c="dimmed" lineClamp={2}>
							{message}
						</Text>
					)}
					{createdLabel && (
						<Text size="xs" c="dimmed">
							{createdLabel}
						</Text>
					)}
				</Stack>
			</Group>
		</UnstyledButton>
	);
}
