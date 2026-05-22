import { Trans } from "@lingui/react/macro";
import {
	Bell,
	type Icon,
	Megaphone,
	WarningCircle,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import {
	useInfiniteAnnouncements,
	useUnreadAnnouncements,
} from "@/components/announcement/hooks";
import { useProcessedAnnouncements } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import {
	resolveNotificationHref,
	useMarkNotificationRead,
	useNotifications,
	useUnreadNotificationCount,
} from "@/hooks/useNotifications";
import { useSidebarView } from "../hooks/useSidebarView";
import { SectionLabel } from "../primitives/SectionLabel";
import { ViewHeader } from "../primitives/ViewHeader";

interface InboxSummaryPanelProps {
	icon: Icon;
	title: ReactNode;
	description: ReactNode;
	count?: number;
	destructive?: boolean;
}

const InboxSummaryPanel = ({
	icon: Icon,
	title,
	description,
	count,
	destructive,
}: InboxSummaryPanelProps) => (
	<div
		className="mx-1 grid grid-cols-[22px_1fr_auto] items-start gap-2 rounded-md border px-2 py-2"
		style={{
			backgroundColor: destructive
				? "rgba(192, 57, 43, 0.05)"
				: "rgba(255, 255, 255, 0.42)",
			borderColor: destructive
				? "rgba(192, 57, 43, 0.16)"
				: "rgba(45, 45, 44, 0.07)",
			color: destructive ? "#c0392b" : "#2d2d2c",
		}}
	>
		<Icon size={16} className="mt-0.5" />
		<div className="min-w-0">
			<div className="truncate text-[13px] leading-tight">{title}</div>
			<div
				className="mt-0.5 line-clamp-2 text-[11px] leading-snug"
				style={{ color: "rgba(45, 45, 44, 0.56)" }}
			>
				{description}
			</div>
		</div>
		{count && count > 0 ? (
			<span
				className="rounded px-1.5 py-0.5 text-[10px] leading-none"
				style={{
					backgroundColor: destructive
						? "rgba(192, 57, 43, 0.12)"
						: "rgba(65, 105, 225, 0.1)",
					color: destructive ? "#c0392b" : "#4169e1",
				}}
			>
				{count}
			</span>
		) : null}
	</div>
);

export const InboxView = () => {
	const { backTo } = useSidebarView();
	const navigate = useI18nNavigate();
	const { language } = useLanguage();
	const { data: notifications = [] } = useNotifications();
	const { data: unreadNotifications = 0 } = useUnreadNotificationCount();
	const { data: unreadAnnouncements = 0 } = useUnreadAnnouncements();
	const markNotificationRead = useMarkNotificationRead();
	const announcementsQuery = useInfiniteAnnouncements({
		enabled: true,
		options: { initialLimit: 5 },
	});
	const allAnnouncements =
		announcementsQuery.data?.pages.flatMap(
			(page) => (page as { announcements: Announcement[] }).announcements,
		) ?? [];
	const announcements = useProcessedAnnouncements(allAnnouncements, language);
	const urgentCount = useMemo(
		() =>
			notifications.filter(
				(n) =>
					!n.read &&
					(n.severity === "action_required" || n.severity === "destructive"),
			).length,
		[notifications],
	);
	const recentNotifications = notifications.slice(0, 4);
	const recentAnnouncements = announcements.slice(0, 3);

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<ViewHeader to={backTo ?? "/w"} title={<Trans>Inbox</Trans>} />
			<InboxSummaryPanel
				title={<Trans>What's new</Trans>}
				icon={Megaphone}
				description={<Trans>Product updates from dembrane.</Trans>}
				count={unreadAnnouncements}
			/>
			<InboxSummaryPanel
				title={<Trans>Notifications</Trans>}
				icon={Bell}
				description={
					<Trans>Activity from your organisations and workspaces.</Trans>
				}
				count={unreadNotifications}
			/>
			{urgentCount > 0 && (
				<InboxSummaryPanel
					title={<Trans>Urgent</Trans>}
					icon={WarningCircle}
					description={<Trans>Items that need attention.</Trans>}
					count={urgentCount}
					destructive
				/>
			)}

			{recentNotifications.length > 0 && (
				<>
					<SectionLabel>
						<Trans>Recent notifications</Trans>
					</SectionLabel>
					{recentNotifications.map((row) => (
						<button
							type="button"
							key={row.id}
							onClick={() => {
								if (!row.read) markNotificationRead.mutate(row.id);
								const href = resolveNotificationHref(row);
								if (href) navigate(href);
							}}
							className="mx-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/[0.04]"
							style={{
								backgroundColor: row.read
									? "transparent"
									: "rgba(65, 105, 225, 0.055)",
							}}
						>
							<div
								className="line-clamp-2 text-[12px] leading-snug"
								style={{ color: "#2d2d2c" }}
							>
								{row.title}
							</div>
							{row.scope && (
								<div
									className="mt-0.5 truncate text-[11px]"
									style={{ color: "rgba(45, 45, 44, 0.5)" }}
								>
									{row.scope}
								</div>
							)}
						</button>
					))}
				</>
			)}

			{recentAnnouncements.length > 0 && (
				<>
					<SectionLabel>
						<Trans>Recent updates</Trans>
					</SectionLabel>
					{recentAnnouncements.map((announcement) => (
						<div
							key={announcement.id}
							className="mx-1 rounded-md px-2 py-1.5"
							style={{ backgroundColor: "rgba(45, 45, 44, 0.035)" }}
						>
							<div
								className="line-clamp-2 text-[12px] leading-snug"
								style={{ color: "#2d2d2c" }}
							>
								{announcement.title}
							</div>
						</div>
					))}
				</>
			)}
		</nav>
	);
};
