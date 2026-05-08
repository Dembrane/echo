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
	ScrollArea,
	Stack,
	Tabs,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconBell, IconCheck } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import {
	useInfiniteAnnouncements,
	useMarkAllAsReadMutation as useAnnouncementsMarkAllAsReadMutation,
	useMarkAsReadMutation as useAnnouncementMarkAsReadMutation,
	useMarkAsUnreadMutation as useAnnouncementMarkAsUnreadMutation,
	useUnreadAnnouncements,
} from "@/components/announcement/hooks";
import { useProcessedAnnouncements } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { AnnouncementItem } from "@/components/announcement/AnnouncementItem";
import {
	resolveNotificationHref,
	useMarkAllNotificationsRead,
	useMarkNotificationRead,
	useNotifications,
	useUnreadNotificationCount,
	type NotificationRow,
} from "@/hooks/useNotifications";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { avatarUrl } from "@/lib/avatar";

/**
 * Unified Inbox drawer — single entry point in the header.
 *
 * Replaces the separate announcement icon + notifications icon pair with
 * one bell that opens a two-tab drawer:
 *
 *   For you        Personal notifications — events that target this user
 *                  specifically (workspace added, role changed, report
 *                  ready, destructive events). Rendered with severity
 *                  styling per the designer spec in `docs/workspaces/
 *                  inbox.html`.
 *
 *   Announcements  Admin broadcasts — existing `announcement` collection.
 *                  Never action-required, never destructive by design.
 *
 * The unread badge sums both streams so users only track one number.
 * "Mark all read" applies to the active tab so users don't nuke
 * announcements when they meant to clear notifications (or vice versa).
 */
export const Inbox = () => {
	const [opened, { open, close }] = useDisclosure(false);
	const [activeTab, setActiveTab] = useState<"for-you" | "announcements">(
		"for-you",
	);
	const navigate = useI18nNavigate();
	const { language } = useLanguage();

	const { data: notifications = [], isLoading: loadingNotifs } =
		useNotifications();
	const { data: unreadNotifs = 0 } = useUnreadNotificationCount();
	const markNotifRead = useMarkNotificationRead();
	const markAllNotifsRead = useMarkAllNotificationsRead();

	const { ref: loadMoreRef, inView } = useInView();
	const {
		data: announcementsData,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isLoading: loadingAnnouncements,
	} = useInfiniteAnnouncements({
		enabled: opened,
		options: { initialLimit: 10 },
	});
	const { data: unreadAnnouncements = 0 } = useUnreadAnnouncements();
	const markAnnouncementRead = useAnnouncementMarkAsReadMutation();
	const markAnnouncementUnread = useAnnouncementMarkAsUnreadMutation();
	const markAllAnnouncementsRead = useAnnouncementsMarkAllAsReadMutation();

	const allAnnouncements =
		announcementsData?.pages.flatMap(
			(page) => (page as { announcements: Announcement[] }).announcements,
		) ?? [];
	const processedAnnouncements = useProcessedAnnouncements(
		allAnnouncements,
		language,
	);
	const unreadAnnouncementRows = useMemo(
		() => processedAnnouncements.filter((a) => !a.read),
		[processedAnnouncements],
	);
	const readAnnouncementRows = useMemo(
		() => processedAnnouncements.filter((a) => a.read),
		[processedAnnouncements],
	);

	// Infinite-scroll sentinel. Fire-and-forget inside useEffect so the
	// fetch doesn't run during render (which caused max-depth churn on
	// the Announcements tab in the 2026-04-23 audit).
	useEffect(() => {
		if (inView && hasNextPage && !isFetchingNextPage) {
			fetchNextPage();
		}
	}, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

	const totalUnread = unreadNotifs + unreadAnnouncements;

	const handleNotificationClick = (row: NotificationRow) => {
		if (!row.read) markNotifRead.mutate(row.id);
		const href = resolveNotificationHref(row);
		if (href) {
			navigate(href);
			close();
		}
	};

	const handleMarkRead = (row: NotificationRow) => {
		if (!row.read) markNotifRead.mutate(row.id);
	};

	const handleMarkAllReadForActiveTab = () => {
		if (activeTab === "for-you") {
			markAllNotifsRead.mutate();
		} else {
			markAllAnnouncementsRead.mutate();
		}
	};

	const markAllPending =
		activeTab === "for-you"
			? markAllNotifsRead.isPending
			: markAllAnnouncementsRead.isPending;

	return (
		<>
			<Indicator
				inline
				size={18}
				offset={4}
				color="primary"
				label={totalUnread > 0 ? totalUnread : undefined}
				disabled={totalUnread === 0}
				withBorder
			>
				<ActionIcon
					variant="transparent"
					color="gray"
					onClick={open}
					aria-label={t`Inbox`}
				>
					<IconBell size={22} />
				</ActionIcon>
			</Indicator>

			<Drawer
				opened={opened}
				onClose={close}
				position="right"
				padding="lg"
				size="md"
				title={
					<Group gap="sm" justify="space-between" w="100%">
						<Text fw={500} size="lg">
							<Trans>Inbox</Trans>
						</Text>
						<Button
							variant="subtle"
							size="compact-xs"
							leftSection={<IconCheck size={12} />}
							onClick={handleMarkAllReadForActiveTab}
							loading={markAllPending}
						>
							<Trans>Mark all read</Trans>
						</Button>
					</Group>
				}
			>
				<Tabs
					value={activeTab}
					onChange={(value) =>
						setActiveTab((value as "for-you" | "announcements") ?? "for-you")
					}
					variant="default"
					keepMounted={false}
				>
					<Tabs.List mb="sm">
						<Tabs.Tab
							value="for-you"
							rightSection={
								unreadNotifs > 0 ? (
									<Badge size="xs" variant="filled" color="blue">
										{unreadNotifs}
									</Badge>
								) : null
							}
						>
							<Trans>For you</Trans>
						</Tabs.Tab>
						<Tabs.Tab
							value="announcements"
							rightSection={
								unreadAnnouncements > 0 ? (
									<Badge size="xs" variant="light" color="blue">
										{unreadAnnouncements}
									</Badge>
								) : null
							}
						>
							<Trans>Announcements</Trans>
						</Tabs.Tab>
					</Tabs.List>

					<Tabs.Panel value="for-you">
						<ScrollArea style={{ height: "calc(100vh - 180px)" }}>
							{loadingNotifs ? (
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
										<NotificationRowItem
											key={row.id}
											row={row}
											onClick={() => handleNotificationClick(row)}
											onMarkRead={() => handleMarkRead(row)}
										/>
									))}
								</Stack>
							)}
						</ScrollArea>
					</Tabs.Panel>

					<Tabs.Panel value="announcements">
						<ScrollArea style={{ height: "calc(100vh - 180px)" }}>
							{loadingAnnouncements ? (
								<Center py="xl">
									<Loader size="sm" color="gray" />
								</Center>
							) : processedAnnouncements.length === 0 ? (
								<Center py="xl">
									<Text size="sm" c="dimmed" ta="center">
										<Trans>Nothing from dembrane right now.</Trans>
									</Text>
								</Center>
							) : (
								<Stack gap={0}>
									{unreadAnnouncementRows.map((a, index) => (
										<AnnouncementItem
											key={a.id}
											announcement={a}
											onMarkAsRead={(id) =>
												markAnnouncementRead.mutate({ announcementId: id })
											}
											onMarkAsUnread={(id, activityIds) =>
												markAnnouncementUnread.mutate({
													announcementId: id,
													activityIds,
												})
											}
											index={index}
										/>
									))}
									{readAnnouncementRows.map((a, index) => (
										<AnnouncementItem
											key={a.id}
											announcement={a}
											onMarkAsRead={(id) =>
												markAnnouncementRead.mutate({ announcementId: id })
											}
											onMarkAsUnread={(id, activityIds) =>
												markAnnouncementUnread.mutate({
													announcementId: id,
													activityIds,
												})
											}
											index={index}
										/>
									))}
									{isFetchingNextPage && (
										<Center py="md">
											<Loader size="xs" />
										</Center>
									)}
									<div ref={loadMoreRef} />
								</Stack>
							)}
						</ScrollArea>
					</Tabs.Panel>
				</Tabs>
			</Drawer>
		</>
	);
};

/**
 * Render inline **bold** markers as <strong>. Notifications come from
 * the server with markdown-style emphasis (e.g. "Added to **Workspace
 * X**"); before this helper the raw asterisks were showing through.
 * Kept tiny on purpose — a full markdown parser is overkill for one
 * line of text, and inline pasting of arbitrary HTML is a no-go.
 */
function renderInlineMarkdown(text: string): React.ReactNode {
	if (!text) return null;
	const parts = text.split(/(\*\*[^*]+\*\*)/g);
	return parts.map((part, i) => {
		if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
			return (
				// biome-ignore lint/suspicious/noArrayIndexKey: parts array is derived from a static text split and never reorders
				<strong key={i} style={{ fontWeight: 600 }}>
					{part.slice(2, -2)}
				</strong>
			);
		}
		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts array is derived from a static text split and never reorders
			<span key={i}>{part}</span>
		);
	});
}

function NotificationRowItem({
	row,
	onClick,
	onMarkRead,
}: {
	row: NotificationRow;
	onClick: () => void;
	onMarkRead: () => void;
}) {
	const createdLabel = row.created_at
		? formatRelative(new Date(row.created_at), new Date())
		: "";
	const isDestructive = row.severity === "destructive";
	const isActionRequired = row.severity === "action_required";
	const unreadBg = isDestructive
		? "rgba(192,57,43,0.045)"
		: isActionRequired
			? "rgba(65,105,225,0.04)"
			: "rgba(65,105,225,0.03)";

	// Clicking the row fires `onClick` (mark-read + navigate when there's
	// an action). Notifications without a navigation target (matrix §6
	// "silent rejection", e.g. status info) used to render as a disabled
	// button — impossible to mark read. Now the row is always clickable
	// and falls back to a plain mark-read when there's no action.
	return (
		<UnstyledButton
			onClick={onClick}
			style={{
				display: "block",
				padding: "12px 4px",
				borderBottom: "1px solid var(--mantine-color-gray-2)",
				cursor: "pointer",
				background: row.read ? "transparent" : unreadBg,
			}}
		>
			<Group
				gap="sm"
				wrap="nowrap"
				align="flex-start"
				style={{ position: "relative" }}
			>
				{/* Explicit mark-read on unread rows. Clicking the row already
				    fires onClick which marks read + (optionally) navigates,
				    but this gives a keyboard/touch target that means "just
				    clear it, don't take me anywhere" — matters when the row
				    has a navigation target the user doesn't want to follow. */}
				{!row.read && (
					<ActionIcon
						size="xs"
						variant="subtle"
						color="gray"
						aria-label={t`Mark as read`}
						onClick={(e) => {
							e.stopPropagation();
							onMarkRead();
						}}
						style={{
							position: "absolute",
							top: 0,
							right: 0,
						}}
					>
						<IconCheck size={12} />
					</ActionIcon>
				)}
				{row.actor_user_id ? (
					<Avatar
						src={avatarUrl(row.actor_avatar, 48)}
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
							background: isDestructive
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
								isDestructive
									? "var(--mantine-color-red-7)"
									: "var(--mantine-color-blue-7)"
							}
						/>
					</Box>
				)}

				<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
					<Group gap="xs" align="center" wrap="nowrap">
						<Text size="sm" fw={row.read ? 400 : 500} lineClamp={1}>
							{renderInlineMarkdown(row.title)}
						</Text>
						{!row.read && (
							<Box
								style={{
									width: 6,
									height: 6,
									borderRadius: "50%",
									background: isDestructive
										? "var(--mantine-color-red-6)"
										: "var(--mantine-color-blue-6)",
									flexShrink: 0,
								}}
								aria-label={t`Unread`}
							/>
						)}
						{isActionRequired && (
							<Badge size="xs" color="blue" variant="filled">
								<Trans>Action needed</Trans>
							</Badge>
						)}
					</Group>
					{row.scope && (
						<Text size="xs" c="dimmed" lineClamp={1}>
							{row.scope}
						</Text>
					)}
					{row.message && (
						<Text size="xs" c="dimmed" lineClamp={2}>
							{renderInlineMarkdown(row.message)}
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
