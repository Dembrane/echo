import { Trans } from "@lingui/react/macro";
import { Box, Center, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useAnnouncementDrawer } from "@/components/announcement/hooks";
import { useProcessedAnnouncements } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { useLanguage } from "@/hooks/useLanguage";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { Drawer } from "../common/Drawer";
import { AnnouncementDrawerHeader } from "./AnnouncementDrawerHeader";
import { AnnouncementErrorState } from "./AnnouncementErrorState";
import { AnnouncementItem } from "./AnnouncementItem";
import { AnnouncementSkeleton } from "./AnnouncementSkeleton";
import {
	useInfiniteAnnouncements,
	useMarkAllAsReadMutation,
	useMarkAsReadMutation,
} from "./hooks";

export const Announcements = () => {
	const { isOpen, close } = useAnnouncementDrawer();
	const { language } = useLanguage();
	const markAsReadMutation = useMarkAsReadMutation();
	const markAllAsReadMutation = useMarkAllAsReadMutation();
	const [openedOnce, setOpenedOnce] = useState(false);

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

	// Flatten all announcements from all pages, with type safety
	const allAnnouncements =
		announcementsData?.pages.flatMap(
			(page) => (page as { announcements: Announcement[] }).announcements,
		) ?? [];

	// Process announcements with translations and read status
	const processedAnnouncements = useProcessedAnnouncements(
		allAnnouncements,
		language,
	);

	// Load more announcements when user scrolls to bottom
	useEffect(() => {
		if (inView && hasNextPage && !isFetchingNextPage) {
			fetchNextPage();
		}
	}, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

	const handleMarkAsRead = async (id: string) => {
		markAsReadMutation.mutate({
			announcementId: id,
		});
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
						) : processedAnnouncements.length === 0 ? (
							<Box p="md">
								<Text c="dimmed" ta="center">
									<Trans>No announcements available</Trans>
								</Text>
							</Box>
						) : (
							<>
								{processedAnnouncements.map((announcement, index) => (
									<AnnouncementItem
										key={announcement.id}
										announcement={announcement}
										onMarkAsRead={handleMarkAsRead}
										index={index}
										ref={
											index === processedAnnouncements.length - 1
												? loadMoreRef
												: undefined
										}
									/>
								))}
								{isFetchingNextPage && (
									<Center py="xl">
										<Loader size="md" />
									</Center>
								)}
							</>
						)}
					</Stack>
				</ScrollArea>
			</Stack>
		</Drawer>
	);
};
