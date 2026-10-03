import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Loader,
	Skeleton,
	Stack,
	Tabs,
	Text,
} from "@mantine/core";
import { ArrowCounterClockwise, Bell, Check } from "@phosphor-icons/react";
import { formatRelative } from "date-fns";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useSearchParams } from "react-router";
import { roles } from "@/colors";
import {
	useMarkAsReadMutation as useAnnouncementMarkAsReadMutation,
	useMarkAsUnreadMutation as useAnnouncementMarkAsUnreadMutation,
	useMarkAllAsReadMutation as useAnnouncementsMarkAllAsReadMutation,
	useInfiniteAnnouncements,
	useUnreadAnnouncements,
} from "@/components/announcement/hooks";
import {
	type ProcessedAnnouncement,
	useProcessedAnnouncements,
} from "@/components/announcement/hooks/useProcessedAnnouncements";
import { useFormatDate } from "@/components/announcement/utils/dateUtils";
import { Markdown } from "@/components/common/Markdown";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import {
	type NotificationRow,
	resolveNotificationHref,
	useMarkAllNotificationsRead,
	useMarkNotificationRead,
	useNotifications,
	useUnreadNotificationCount,
} from "@/hooks/useNotifications";
import { avatarUrl } from "@/lib/avatar";
import {
	type PendingAction,
	useTrainingPendingActions,
} from "../hooks/usePendingActions";
import { SIDEBAR_TAB_PARAM } from "../hooks/useSidebarOverlayLink";
import { useSidebarView } from "../hooks/useSidebarView";
import { ViewHeader } from "../primitives/ViewHeader";

type Tab = "for-you" | "announcements";

export const InboxView = () => {
	const { backTo } = useSidebarView();
	// In the URL so the sidebar can deep-link to it. Param says "updates", the
	// internal value stays "announcements".
	const [searchParams, setSearchParams] = useSearchParams();
	const activeTab: Tab =
		searchParams.get(SIDEBAR_TAB_PARAM) === "updates"
			? "announcements"
			: "for-you";

	const setActiveTab = useCallback(
		(tab: Tab) => {
			const next = new URLSearchParams(searchParams);
			if (tab === "announcements") {
				next.set(SIDEBAR_TAB_PARAM, "updates");
			} else {
				next.delete(SIDEBAR_TAB_PARAM);
			}
			setSearchParams(next, { replace: true });
		},
		[searchParams, setSearchParams],
	);
	const navigate = useI18nNavigate();
	const { language } = useLanguage();

	const { data: notifications = [], isLoading: loadingNotifs } =
		useNotifications();
	const { data: unreadNotifs = 0 } = useUnreadNotificationCount();
	// Non-blocking pending actions (high-risk training nudge + future sources).
	const pendingActions = useTrainingPendingActions();
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
		enabled: true,
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

	useEffect(() => {
		if (inView && hasNextPage && !isFetchingNextPage) {
			fetchNextPage();
		}
	}, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

	const handleNotificationClick = (row: NotificationRow) => {
		if (!row.read) markNotifRead.mutate(row.id);
		const href = resolveNotificationHref(row);
		if (href) navigate(href);
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

	const markAllDisabled =
		activeTab === "for-you" ? unreadNotifs === 0 : unreadAnnouncements === 0;

	return (
		<div className="flex h-full w-full justify-center overflow-hidden">
			<nav className="flex h-full w-full max-w-2xl flex-col px-4 py-6">
				<div className="shrink-0 p-1.5">
					<ViewHeader to={backTo ?? "/o"} title={<Trans>Inbox</Trans>} />
				</div>

				<div className="flex shrink-0 flex-col items-start gap-1 px-1.5 pb-2">
					<Tabs
						value={activeTab}
						onChange={(value) => {
							if (value === "for-you" || value === "announcements") {
								setActiveTab(value);
							}
						}}
						className="w-full"
					>
						<Tabs.List>
							<Tabs.Tab
								value="for-you"
								rightSection={<TabCount count={unreadNotifs} />}
							>
								<Trans>For you</Trans>
							</Tabs.Tab>
							<Tabs.Tab
								value="announcements"
								rightSection={<TabCount count={unreadAnnouncements} />}
							>
								<Trans>Updates</Trans>
							</Tabs.Tab>
						</Tabs.List>
					</Tabs>
					<Button
						variant="subtle"
						color="gray"
						size="xs"
						onClick={handleMarkAllReadForActiveTab}
						disabled={markAllDisabled || markAllPending}
						leftSection={<Check size={20} />}
						aria-label={t`Mark all as read`}
					>
						<Trans>All read</Trans>
					</Button>
				</div>

				<div className="flex-1 overflow-y-auto px-1.5 pb-2">
					{activeTab === "for-you" ? (
						<ForYouPanel
							loading={loadingNotifs}
							rows={notifications}
							pendingActions={pendingActions}
							onPendingActionClick={(action) => navigate(action.href)}
							onRowClick={handleNotificationClick}
							onMarkRead={(row) => {
								if (!row.read) markNotifRead.mutate(row.id);
							}}
						/>
					) : (
						<AnnouncementsPanel
							loading={loadingAnnouncements}
							announcements={processedAnnouncements}
							onMarkRead={(id, activityIds) =>
								markAnnouncementRead.mutate({ activityIds, announcementId: id })
							}
							onMarkUnread={(id, activityIds) =>
								markAnnouncementUnread.mutate({
									activityIds,
									announcementId: id,
								})
							}
							isFetchingNextPage={isFetchingNextPage}
							loadMoreRef={loadMoreRef}
						/>
					)}
				</div>
			</nav>
		</div>
	);
};

const TabCount = ({ count }: { count: number }) =>
	count > 0 ? (
		<Badge size="sm" color="primary">
			{count}
		</Badge>
	) : null;

interface ForYouPanelProps {
	loading: boolean;
	rows: NotificationRow[];
	pendingActions: PendingAction[];
	onPendingActionClick: (action: PendingAction) => void;
	onRowClick: (row: NotificationRow) => void;
	onMarkRead: (row: NotificationRow) => void;
}

const ForYouPanel = ({
	loading,
	rows,
	pendingActions,
	onPendingActionClick,
	onRowClick,
	onMarkRead,
}: ForYouPanelProps) => {
	if (loading) {
		return <SkeletonList />;
	}
	if (rows.length === 0 && pendingActions.length === 0) {
		return <EmptyState message={<Trans>You're all caught up.</Trans>} />;
	}
	return (
		<ul className="flex flex-col gap-1">
			{pendingActions.map((action) => (
				<li key={action.code}>
					<PendingActionRow
						action={action}
						onClick={() => onPendingActionClick(action)}
					/>
				</li>
			))}
			{rows.map((row) => (
				<li key={row.id}>
					<NotificationRowItem
						row={row}
						onClick={() => onRowClick(row)}
						onMarkRead={() => onMarkRead(row)}
					/>
				</li>
			))}
		</ul>
	);
};

/**
 * A non-blocking pending action (e.g. the high-risk training nudge). Warns,
 * never blocks: it's a tappable row that points to the action. The warning
 * tint on its badge matches the Inbox nav badge tone; text stays graphite.
 */
const PendingActionRow = ({
	action,
	onClick,
}: {
	action: PendingAction;
	onClick: () => void;
}) => (
	<button
		type="button"
		onClick={onClick}
		className="app-do w-full px-2 py-2"
		data-testid="inbox-pending-action"
	>
		<div className="text-xs leading-snug">{action.title}</div>
		<div className="mt-0.5 text-xs leading-snug">{action.message}</div>
		<div className="mt-1">
			<Badge size="sm" color="yellow">
				<Trans>Pending action</Trans>
			</Badge>
		</div>
	</button>
);

interface AnnouncementsPanelProps {
	loading: boolean;
	announcements: ReturnType<typeof useProcessedAnnouncements>;
	onMarkRead: (id: string, activityIds: string[]) => void;
	onMarkUnread: (id: string, activityIds: string[]) => void;
	isFetchingNextPage: boolean;
	loadMoreRef: (node?: Element | null) => void;
}

const AnnouncementsPanel = ({
	loading,
	announcements,
	onMarkRead,
	onMarkUnread,
	isFetchingNextPage,
	loadMoreRef,
}: AnnouncementsPanelProps) => {
	if (loading) {
		return <SkeletonList />;
	}
	if (announcements.length === 0) {
		return (
			<EmptyState message={<Trans>Nothing from dembrane right now.</Trans>} />
		);
	}
	return (
		<ul className="flex flex-col gap-1">
			{announcements.map((a) => (
				<li key={a.id}>
					<AnnouncementRowItem
						announcement={a}
						onMarkRead={onMarkRead}
						onMarkUnread={onMarkUnread}
					/>
				</li>
			))}
			{isFetchingNextPage && (
				<li className="px-2 py-2">
					<Loader size="sm" />
				</li>
			)}
			<li ref={loadMoreRef} aria-hidden="true" />
		</ul>
	);
};

const SkeletonList = () => (
	<Stack gap="sm" px="xs" py="sm">
		{[0, 1, 2].map((i) => (
			<Skeleton key={i} h={40} radius={0} />
		))}
	</Stack>
);

const EmptyState = ({ message }: { message: ReactNode }) => (
	<Text size="sm" c="dimmed" className="app-muted" px="sm" py="md">
		{message}
	</Text>
);

function renderInlineMarkdown(text: string): ReactNode {
	if (!text) return null;
	const parts = text.split(/(\*\*[^*]+\*\*)/g);
	return parts.map((part, i) => {
		if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
			return (
				// biome-ignore lint/suspicious/noArrayIndexKey: parts array is derived from a static text split and never reorders
				<strong key={i}>{part.slice(2, -2)}</strong>
			);
		}
		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts array is derived from a static text split and never reorders
			<span key={i}>{part}</span>
		);
	});
}

interface NotificationRowItemProps {
	row: NotificationRow;
	onClick: () => void;
	onMarkRead: () => void;
}

const NotificationRowItem = ({
	row,
	onClick,
	onMarkRead,
}: NotificationRowItemProps) => {
	const createdLabel = row.created_at
		? formatRelative(new Date(row.created_at), new Date())
		: "";
	const isDestructive = row.severity === "destructive";
	const isActionRequired = row.severity === "action_required";

	// Status lives on the dot and the badge; the row itself stays unfilled.
	const dotColor = isDestructive ? roles.danger : roles.action;

	return (
		<div className="group relative">
			<button
				type="button"
				onClick={onClick}
				className="app-do w-full px-2 py-2"
			>
				{!row.read && (
					<span
						aria-hidden="true"
						className="absolute right-2 top-2 inline-block h-1.5 w-1.5 rounded-full"
						style={{ backgroundColor: dotColor }}
					/>
				)}
				<div className="flex items-start gap-2">
					{row.actor_user_id && row.actor_avatar ? (
						<img
							src={avatarUrl(row.actor_avatar, 48) ?? undefined}
							alt=""
							className="h-6 w-6 shrink-0 rounded-full object-cover"
						/>
					) : (
						<span
							className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
							style={{
								backgroundColor: isDestructive
									? roles.dangerTint
									: roles.actionTint,
								color: isDestructive ? roles.dangerOnTint : roles.action,
							}}
							aria-hidden="true"
						>
							{row.actor_user_id && row.actor_name ? (
								<span className="text-xs">
									{row.actor_name.slice(0, 2).toUpperCase()}
								</span>
							) : (
								<Bell size={16} />
							)}
						</span>
					)}
					<div className="min-w-0 flex-1">
						<div className="line-clamp-2 pr-3 text-xs leading-snug">
							{renderInlineMarkdown(row.title)}
						</div>
						{row.scope && (
							<div
								className="app-muted mt-0.5 truncate text-xs"
								style={{ color: "var(--mantine-color-dimmed)" }}
							>
								{row.scope}
							</div>
						)}
						{row.message && (
							<div
								className="app-muted mt-0.5 line-clamp-2 text-xs leading-snug"
								style={{ color: "var(--mantine-color-dimmed)" }}
							>
								{renderInlineMarkdown(row.message)}
							</div>
						)}
						{/* pr-6 clears the read toggle pinned to the bottom-right. */}
						<div className="mt-1 flex items-center justify-between gap-2 pr-6">
							{createdLabel && (
								<span
									className="app-muted truncate text-xs"
									style={{ color: "var(--mantine-color-dimmed)" }}
								>
									{createdLabel}
								</span>
							)}
							{isActionRequired && (
								<Badge size="sm" color="primary" className="shrink-0">
									<Trans>Action needed</Trans>
								</Badge>
							)}
						</div>
					</div>
				</div>
			</button>
			{!row.read && (
				<button
					type="button"
					aria-label={t`Mark as read`}
					onClick={(e) => {
						e.stopPropagation();
						onMarkRead();
					}}
					className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center transition-colors hover:bg-[#e6e3df]"
					style={{ color: "var(--mantine-color-dimmed)" }}
				>
					<Check size={16} />
				</button>
			)}
		</div>
	);
};

interface AnnouncementRowItemProps {
	announcement: ProcessedAnnouncement;
	onMarkRead: (id: string, activityIds: string[]) => void;
	onMarkUnread: (id: string, activityIds: string[]) => void;
}

const AnnouncementRowItem = ({
	announcement,
	onMarkRead,
	onMarkUnread,
}: AnnouncementRowItemProps) => {
	const formatDate = useFormatDate();
	const [expanded, setExpanded] = useState(false);
	const isUrgent = announcement.level === "urgent";
	const isRead = !!announcement.read;
	// Dot only. The card stays unfilled and graphite whatever the level.
	const accent = isUrgent ? roles.danger : roles.action;

	const toggleRead = () => {
		if (isRead) {
			onMarkUnread(announcement.id, announcement.activityIds);
		} else {
			onMarkRead(announcement.id, announcement.activityIds);
		}
	};

	return (
		<div
			className="group relative border px-2 py-2 transition-colors hover:bg-[#e6e3df]"
			style={{
				borderColor: "var(--app-rule-color)",
				color: roles.text,
			}}
		>
			{!isRead && (
				<span
					aria-hidden="true"
					className="absolute right-2 top-2 inline-block h-1.5 w-1.5 rounded-full"
					style={{ backgroundColor: accent }}
				/>
			)}
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="block w-full text-left"
				aria-expanded={expanded}
			>
				<div className="line-clamp-2 pr-3 text-xs leading-snug">
					{announcement.title}
				</div>
				{announcement.message && (
					<div
						className={`app-muted mt-0.5 text-xs leading-snug ${expanded ? "" : "line-clamp-2"}`}
						style={{ color: "var(--mantine-color-dimmed)" }}
					>
						<Markdown content={announcement.message} />
					</div>
				)}
				{/* pr-6 clears the read toggle pinned to the bottom-right. */}
				<div className="mt-1 flex items-center justify-between gap-2 pr-6">
					<span
						className="app-muted truncate text-xs"
						style={{ color: "var(--mantine-color-dimmed)" }}
					>
						{formatDate(announcement.created_at)}
					</span>
					<span
						className="app-muted text-xs underline decoration-dotted"
						style={{ color: "var(--mantine-color-dimmed)" }}
					>
						{expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
					</span>
				</div>
			</button>
			<button
				type="button"
				aria-label={isRead ? t`Mark as unread` : t`Mark as read`}
				onClick={(e) => {
					e.stopPropagation();
					toggleRead();
				}}
				className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center transition-colors hover:bg-[#e6e3df]"
				style={{ color: "var(--mantine-color-dimmed)" }}
			>
				{isRead ? <ArrowCounterClockwise size={16} /> : <Check size={16} />}
			</button>
		</div>
	);
};
