import { Trans } from "@lingui/react/macro";
import {
	Box,
	Center,
	Collapse,
	Divider,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import {
	CaretDown,
	CaretUp,
	CheckCircle,
	Sparkle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useAnnouncementDrawer } from "@/components/announcement/hooks";
import {
	useProcessedAnnouncements,
	useWhatsNewProcessed,
} from "@/components/announcement/hooks/useProcessedAnnouncements";
import { useLanguage } from "@/hooks/useLanguage";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { testId } from "@/lib/testUtils";
import { Drawer } from "../common/Drawer";
import { AnnouncementDrawerHeader } from "./AnnouncementDrawerHeader";
import { AnnouncementErrorState } from "./AnnouncementErrorState";
import { AnnouncementItem } from "./AnnouncementItem";
import { AnnouncementSkeleton } from "./AnnouncementSkeleton";
import { WhatsNewItem } from "./WhatsNewItem";
import {
	useInfiniteAnnouncements,
	useMarkAllAsReadMutation,
	useMarkAsReadMutation,
	useMarkAsUnreadMutation,
	useWhatsNewAnnouncements,
} from "./hooks";

export const Announcements = () => {
	const { isOpen, close } = useAnnouncementDrawer();
	const { language } = useLanguage();
	const markAsReadMutation = useMarkAsReadMutation();
	const markAsUnreadMutation = useMarkAsUnreadMutation();
	const markAllAsReadMutation = useMarkAllAsReadMutation();
	const [openedOnce, setOpenedOnce] = useState(false);
	const [readExpanded, setReadExpanded] = useState(false);
	const [whatsNewExpanded, setWhatsNewExpanded] = useState(false);

	const { ref: loadMoreRef, inView } = useInView();

	// Track when drawer is opened for the first time
	useEffect(() => {
		if (isOpen && !openedOnce) {
			setOpenedOnce(true);
			try {
				analytics.trackEvent(events.ANNOUNCEMENT_CREATED);
			} catch (error) {
				console.warn("Analytics tracking failed:", error);
			}
		}
	}, [isOpen, openedOnce]);

	const {
		data: announcementsData,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isLoading,
		isError,
		refetch,
	} = useInfiniteAnnouncements({
		enabled: openedOnce,
		options: {
			initialLimit: 10,
		},
	});

	const { data: whatsNewData } = useWhatsNewAnnouncements({
		enabled: openedOnce,
	});

	// Flatten all announcements from all pages
	const allAnnouncements =
		announcementsData?.pages.flatMap(
			(page) => (page as { announcements: Announcement[] }).announcements,
		) ?? [];

	// Process announcements with translations and read status
	const processedAnnouncements = useProcessedAnnouncements(
		allAnnouncements,
		language,
	);

	// Split into unread and read
	const unreadAnnouncements = useMemo(
		() => processedAnnouncements.filter((a) => !a.read),
		[processedAnnouncements],
	);
	const readAnnouncements = useMemo(
		() => processedAnnouncements.filter((a) => a.read),
		[processedAnnouncements],
	);

	// Auto-expand read section when there are no unread items
	// biome-ignore lint/correctness/useExhaustiveDependencies: only react to unread/read count changes
	useEffect(() => {
		if (unreadAnnouncements.length === 0 && readAnnouncements.length > 0) {
			setReadExpanded(true);
		}
	}, [unreadAnnouncements.length, readAnnouncements.length]);

	// Process "What's new" announcements, excluding those already in the main list
	const whatsNewRaw = useWhatsNewProcessed(whatsNewData ?? [], language);
	const whatsNewAnnouncements = useMemo(() => {
		const mainIds = new Set(processedAnnouncements.map((a) => a.id));
		return whatsNewRaw.filter((a) => !mainIds.has(a.id));
	}, [whatsNewRaw, processedAnnouncements]);

	// Load more announcements when user scrolls to bottom
	useEffect(() => {
		if (inView && hasNextPage && !isFetchingNextPage) {
			fetchNextPage();
		}
	}, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

	const handleMarkAsRead = async (id: string) => {
		markAsReadMutation.mutate({ announcementId: id });
	};

	const handleMarkAsUnread = async (id: string, activityIds: string[]) => {
		markAsUnreadMutation.mutate({ announcementId: id, activityIds });
	};

	const handleMarkAllAsRead = async () => {
		markAllAsReadMutation.mutate();
	};

	const handleRetry = () => {
		refetch();
	};

	return (
		<Drawer
			opened={isOpen}
			onClose={close}
			position="right"
			title={
				<AnnouncementDrawerHeader
					onClose={close}
					onMarkAllAsRead={handleMarkAllAsRead}
					isPending={markAllAsReadMutation.isPending}
				/>
			}
			classNames={{
				body: "p-0",
				content: "border-0",
				header: "border-b",
				title: "px-3 w-full",
			}}
			withCloseButton={false}
			styles={{
				content: {
					maxWidth: "95%",
				},
			}}
			{...testId("announcement-drawer")}
		>
			<Stack h="100%">
				<ScrollArea className="flex-1">
					<Stack gap="0">
						{isError ? (
							<AnnouncementErrorState
								onRetry={handleRetry}
								isLoading={isLoading}
							/>
						) : isLoading ? (
							<AnnouncementSkeleton />
						) : processedAnnouncements.length === 0 &&
							whatsNewAnnouncements.length === 0 ? (
							<Box p="md" {...testId("announcement-empty-state")}>
								<Text c="dimmed" ta="center">
									<Trans>No announcements available</Trans>
								</Text>
							</Box>
						) : (
							<>
								{/* Unread announcements */}
								{unreadAnnouncements.map((announcement, index) => (
									<AnnouncementItem
										key={announcement.id}
										announcement={announcement}
										onMarkAsRead={handleMarkAsRead}
										onMarkAsUnread={handleMarkAsUnread}
										index={index}
									/>
								))}

								{isFetchingNextPage && (
									<Center py="xl">
										<Loader size="md" />
									</Center>
								)}

								{/* Earlier (read) section */}
								{readAnnouncements.length > 0 && (
									<>
										<Divider
											my="md"
											mx="md"
											label={
												<UnstyledButton
													onClick={() =>
														setReadExpanded(!readExpanded)
													}
												>
													<Group gap="xs" align="center">
														<CheckCircle
															size={16}
															weight="fill"
															color="gray"
														/>
														<Text
															size="sm"
															fw={500}
															c="dimmed"
														>
															<Trans>Earlier</Trans>
														</Text>
														{readExpanded ? (
															<CaretUp size={14} color="gray" />
														) : (
															<CaretDown size={14} color="gray" />
														)}
													</Group>
												</UnstyledButton>
											}
											labelPosition="left"
										/>

										<Collapse in={readExpanded}>
											<Stack gap="0">
												{readAnnouncements.map(
													(announcement, index) => (
														<AnnouncementItem
															key={announcement.id}
															announcement={announcement}
															onMarkAsRead={handleMarkAsRead}
															index={index}
														/>
													),
												)}
											</Stack>
										</Collapse>
									</>
								)}

								{/* Release notes */}
								{whatsNewAnnouncements.length > 0 && (
									<>
										<Divider
											my="md"
											mx="md"
											label={
												<UnstyledButton
													onClick={() =>
														setWhatsNewExpanded(!whatsNewExpanded)
													}
												>
													<Group gap="xs" align="center">
														<Sparkle
															size={16}
															weight="fill"
															color="#4169e1"
														/>
														<Text
															size="sm"
															fw={500}
															c="#4169e1"
														>
															<Trans>Release notes</Trans>
														</Text>
														{whatsNewExpanded ? (
															<CaretUp size={14} color="#4169e1" />
														) : (
															<CaretDown size={14} color="#4169e1" />
														)}
													</Group>
												</UnstyledButton>
											}
											labelPosition="left"
										/>

										<Collapse in={whatsNewExpanded}>
											<Stack gap="0">
												{whatsNewAnnouncements.map((announcement) => (
													<WhatsNewItem
														key={announcement.id}
														announcement={announcement}
													/>
												))}
											</Stack>
										</Collapse>
									</>
								)}

								{/* Infinite scroll sentinel */}
								<div ref={loadMoreRef} />
							</>
						)}
					</Stack>
				</ScrollArea>
			</Stack>
		</Drawer>
	);
};
