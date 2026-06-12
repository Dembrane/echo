import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowCounterClockwise, Bell, Check } from "@phosphor-icons/react";
import { formatRelative } from "date-fns";
import { type ReactNode, useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
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
import { useSidebarView } from "../hooks/useSidebarView";
import { ViewHeader } from "../primitives/ViewHeader";

type Tab = "for-you" | "announcements";

export const InboxView = () => {
	const { backTo } = useSidebarView();
	const [activeTab, setActiveTab] = useState<Tab>("for-you");
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
	
				<div className="flex shrink-0 items-center justify-between gap-1 px-3 pb-2">
					<div className="flex gap-1">
						<TabButton
							active={activeTab === "for-you"}
							onClick={() => setActiveTab("for-you")}
							badge={unreadNotifs}
						>
							<Trans>For you</Trans>
						</TabButton>
						<TabButton
							active={activeTab === "announcements"}
							onClick={() => setActiveTab("announcements")}
							badge={unreadAnnouncements}
						>
							<Trans>Updates</Trans>
						</TabButton>
					</div>
					<button
						type="button"
						onClick={handleMarkAllReadForActiveTab}
						disabled={markAllDisabled || markAllPending}
						className="flex items-center gap-1 rounded px-1.5 py-1 text-[0.6875rem] transition-colors enabled:hover:bg-black/[0.04] disabled:opacity-40"
						style={{ color: "rgba(45, 45, 44, 0.6)" }}
						aria-label={t`Mark all as read`}
					>
						<Check size={12} />
						<Trans>All read</Trans>
					</button>
				</div>
	
				<div className="flex-1 overflow-y-auto px-1.5 pb-2">
					{activeTab === "for-you" ? (
						<ForYouPanel
							loading={loadingNotifs}
							rows={notifications}
							onRowClick={handleNotificationClick}
							onMarkRead={(row) => {
								if (!row.read) markNotifRead.mutate(row.id);
							}}
						/>
					) : (
						<AnnouncementsPanel
							loading={loadingAnnouncements}
							announcements={processedAnnouncements}
							onMarkRead={(id) =>
								markAnnouncementRead.mutate({ announcementId: id })
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

interface TabButtonProps {
	active: boolean;
	onClick: () => void;
	badge: number;
	children: ReactNode;
}

const TabButton = ({ active, onClick, badge, children }: TabButtonProps) => (
	<button
		type="button"
		onClick={onClick}
		className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
		style={{
			backgroundColor: active ? "rgba(65, 105, 225, 0.08)" : "transparent",
			color: active ? "#4169e1" : "rgba(45, 45, 44, 0.7)",
		}}
	>
		<span>{children}</span>
		{badge > 0 && (
			<span
				className="rounded px-1 text-[0.625rem] leading-none"
				style={{
					backgroundColor: "rgba(65, 105, 225, 0.18)",
					color: "#4169e1",
					paddingBlock: 2,
				}}
			>
				{badge}
			</span>
		)}
	</button>
);

interface ForYouPanelProps {
	loading: boolean;
	rows: NotificationRow[];
	onRowClick: (row: NotificationRow) => void;
	onMarkRead: (row: NotificationRow) => void;
}

const ForYouPanel = ({
	loading,
	rows,
	onRowClick,
	onMarkRead,
}: ForYouPanelProps) => {
	if (loading) {
		return <SkeletonList />;
	}
	if (rows.length === 0) {
		return (
			<EmptyState
				icon={<Bell size={22} weight="duotone" />}
				message={<Trans>You're all caught up.</Trans>}
			/>
		);
	}
	return (
		<ul className="flex flex-col gap-1">
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

interface AnnouncementsPanelProps {
	loading: boolean;
	announcements: ReturnType<typeof useProcessedAnnouncements>;
	onMarkRead: (id: string) => void;
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
				<li className="flex justify-center py-2">
					<div
						className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
						style={{ color: "rgba(45, 45, 44, 0.4)" }}
					/>
				</li>
			)}
			<li ref={loadMoreRef} aria-hidden="true" />
		</ul>
	);
};

const SkeletonList = () => (
	<div className="flex flex-col gap-2 px-1 py-3">
		{[0, 1, 2].map((i) => (
			<div
				key={i}
				className="h-10 animate-pulse rounded-md"
				style={{ backgroundColor: "rgba(45, 45, 44, 0.05)" }}
			/>
		))}
	</div>
);

const EmptyState = ({
	icon,
	message,
}: {
	icon?: ReactNode;
	message: ReactNode;
}) => (
	<div
		className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs"
		style={{ color: "rgba(45, 45, 44, 0.55)" }}
	>
		{icon}
		<div>{message}</div>
	</div>
);

function renderInlineMarkdown(text: string): ReactNode {
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

	const unreadBg = isDestructive
		? "rgba(192, 57, 43, 0.05)"
		: isActionRequired
			? "rgba(65, 105, 225, 0.06)"
			: "rgba(65, 105, 225, 0.04)";
	const borderColor = isDestructive
		? "rgba(192, 57, 43, 0.18)"
		: isActionRequired
			? "rgba(65, 105, 225, 0.18)"
			: "rgba(45, 45, 44, 0.07)";
	const dotColor = isDestructive ? "#c0392b" : "#4169e1";

	return (
		<div className="group relative">
			<button
				type="button"
				onClick={onClick}
				className="w-full rounded-md border px-2 py-2 text-left transition-colors hover:bg-black/[0.025]"
				style={{
					backgroundColor: row.read ? "rgba(255, 255, 255, 0.42)" : unreadBg,
					borderColor,
					color: "#2d2d2c",
				}}
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
									? "rgba(192, 57, 43, 0.12)"
									: "rgba(65, 105, 225, 0.12)",
								color: isDestructive ? "#c0392b" : "#4169e1",
							}}
							aria-hidden="true"
						>
							{row.actor_user_id && row.actor_name ? (
								<span className="text-[0.625rem] font-medium">
									{row.actor_name.slice(0, 2).toUpperCase()}
								</span>
							) : (
								<Bell size={12} weight="fill" />
							)}
						</span>
					)}
					<div className="min-w-0 flex-1">
						<div
							className="line-clamp-2 pr-3 text-xs leading-snug"
							style={{ fontWeight: row.read ? 400 : 500 }}
						>
							{renderInlineMarkdown(row.title)}
						</div>
						{row.scope && (
							<div
								className="mt-0.5 truncate text-[0.6875rem]"
								style={{ color: "rgba(45, 45, 44, 0.55)" }}
							>
								{row.scope}
							</div>
						)}
						{row.message && (
							<div
								className="mt-0.5 line-clamp-2 text-[0.6875rem] leading-snug"
								style={{ color: "rgba(45, 45, 44, 0.6)" }}
							>
								{renderInlineMarkdown(row.message)}
							</div>
						)}
						<div className="mt-1 flex items-center justify-between gap-2">
							{createdLabel && (
								<span
									className="truncate text-[0.625rem]"
									style={{ color: "rgba(45, 45, 44, 0.45)" }}
								>
									{createdLabel}
								</span>
							)}
							{isActionRequired && (
								<span
									className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] leading-none"
									style={{
										backgroundColor: "rgba(65, 105, 225, 0.12)",
										color: "#4169e1",
									}}
								>
									<Trans>Action needed</Trans>
								</span>
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
					className="absolute bottom-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-black/[0.06] focus-visible:opacity-100 group-hover:opacity-100"
					style={{ color: "rgba(45, 45, 44, 0.6)" }}
				>
					<Check size={12} />
				</button>
			)}
		</div>
	);
};

interface AnnouncementRowItemProps {
	announcement: ProcessedAnnouncement;
	onMarkRead: (id: string) => void;
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
	const accent = isUrgent ? "#c0392b" : "#4169e1";

	const unreadBg = isUrgent
		? "rgba(192, 57, 43, 0.05)"
		: "rgba(65, 105, 225, 0.04)";
	const borderColor = isUrgent
		? "rgba(192, 57, 43, 0.18)"
		: "rgba(65, 105, 225, 0.18)";

	const toggleRead = () => {
		if (isRead) {
			onMarkUnread(announcement.id, announcement.activityIds);
		} else {
			onMarkRead(announcement.id);
		}
	};

	return (
		<div
			className="group relative rounded-md border px-2 py-2"
			style={{
				backgroundColor: isRead ? "rgba(255, 255, 255, 0.42)" : unreadBg,
				borderColor: isRead ? "rgba(45, 45, 44, 0.07)" : borderColor,
				color: "#2d2d2c",
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
				<div
					className="line-clamp-2 pr-3 text-xs leading-snug"
					style={{ fontWeight: isRead ? 400 : 500 }}
				>
					{announcement.title}
				</div>
				{announcement.message && (
					<div
						className={`mt-0.5 text-[0.6875rem] leading-snug ${expanded ? "" : "line-clamp-2"}`}
						style={{ color: "rgba(45, 45, 44, 0.65)" }}
					>
						<Markdown content={announcement.message} />
					</div>
				)}
				<div className="mt-1 flex items-center justify-between gap-2">
					<span
						className="truncate text-[0.625rem]"
						style={{ color: "rgba(45, 45, 44, 0.45)" }}
					>
						{formatDate(announcement.created_at)}
					</span>
					<span
						className="text-[0.625rem] underline decoration-dotted"
						style={{ color: "rgba(45, 45, 44, 0.55)" }}
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
				className="absolute bottom-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-black/[0.06] focus-visible:opacity-100 group-hover:opacity-100"
				style={{ color: "rgba(45, 45, 44, 0.6)" }}
			>
				{isRead ? <ArrowCounterClockwise size={12} /> : <Check size={12} />}
			</button>
		</div>
	);
};
