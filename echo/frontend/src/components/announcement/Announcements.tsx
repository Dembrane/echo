import {
  Box,
  ScrollArea,
  Stack,
  Text,
  Loader,
  Center,
} from "@mantine/core";
import { Trans } from "@lingui/react/macro";
import { useState, useEffect } from "react";
import { useInView } from "react-intersection-observer";
import { Drawer } from "../common/Drawer";
import { AnnouncementItem } from "./AnnouncementItem";
import {
  useInfiniteAnnouncements,
  useMarkAnnouncementAsReadMutation,
} from "@/lib/query";
import { useLanguage } from "@/hooks/useLanguage";
import { AnnouncementSkeleton } from "./AnnouncementSkeleton";
import { AnnouncementDrawerHeader } from "./AnnouncementDrawerHeader";
import { useProcessedAnnouncements } from "@/hooks/useProcessedAnnouncements";
import { useAnnouncementDrawer } from "@/hooks/useAnnouncementDrawer";

export const Announcements = () => {
  const { isOpen, close } = useAnnouncementDrawer();
  const { language } = useLanguage();
  const markAsReadMutation = useMarkAnnouncementAsReadMutation();
  const [markingAsReadId, setMarkingAsReadId] = useState<string | null>(null);

  const { ref: loadMoreRef, inView } = useInView();

  const {
    data: announcementsData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useInfiniteAnnouncements({
    options: {
      initialLimit: 10,
    },
  });

  // Flatten all announcements from all pages
  const allAnnouncements =
    announcementsData?.pages.flatMap((page) => page.announcements) ?? [];

  // Process announcements with translations and read status
  const processedAnnouncements = useProcessedAnnouncements(
    allAnnouncements as Announcement[],
    language,
  );

  const unreadAnnouncements = processedAnnouncements.filter((a) => !a.read);
  const unreadCount = unreadAnnouncements.length;

  // Load more announcements when user scrolls to bottom
  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleMarkAsRead = async (id: string) => {
    setMarkingAsReadId(id);

    try {
      await markAsReadMutation.mutateAsync({
        announcementIds: [id],
      });
    } catch (error) {
      console.error("Failed to mark announcement as read:", error);
    } finally {
      setMarkingAsReadId(null);
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      // Extract all unread announcement IDs
      const unreadIds = unreadAnnouncements.map(
        (announcement) => announcement.id,
      );

      // Mark all unread announcements as read in one call
      await markAsReadMutation.mutateAsync({
        announcementIds: unreadIds as string[],
      });
    } catch (error) {
      console.error("Failed to mark all announcements as read:", error);
    }
  };

  if (isError) {
    console.error("Error loading announcements:", error);
  }

  return (
    <Drawer
        opened={isOpen}
        onClose={close}
        position="right"
        title={
          <AnnouncementDrawerHeader
            unreadCount={unreadCount}
            onClose={close}
            onMarkAllAsRead={handleMarkAllAsRead}
            isPending={markAsReadMutation.isPending}
          />
        }
        classNames={{
          title: "px-3 w-full",
          header: "border-b",
          body: "p-0",
        }}
        withCloseButton={false}
      >
        <Stack h="100%">
          <ScrollArea className="flex-1">
            <Stack gap="0">
              {isLoading ? (
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
                      isMarkingAsRead={markingAsReadId === announcement.id}
                      ref={
                        index === processedAnnouncements.length - 1
                          ? loadMoreRef
                          : undefined
                      }
                    />
                  ))}
                  {isFetchingNextPage && (
                    <Center>
                      <Loader size="sm" />
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
