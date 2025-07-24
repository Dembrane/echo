import {
  Box,
  ScrollArea,
  Stack,
  Text,
  Loader,
  Center,
  Alert,
  Button,
} from "@mantine/core";
import { Trans } from "@lingui/react/macro";
import { useState, useEffect } from "react";
import { useInView } from "react-intersection-observer";
import { Drawer } from "../common/Drawer";
import { AnnouncementItem } from "./AnnouncementItem";
import {
  useInfiniteAnnouncements,
  useMarkAsReadMutation,
  useMarkAllAsReadMutation,
} from "./hooks";
import { useLanguage } from "@/hooks/useLanguage";
import { AnnouncementSkeleton } from "./AnnouncementSkeleton";
import { AnnouncementDrawerHeader } from "./AnnouncementDrawerHeader";
import { useProcessedAnnouncements } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { useAnnouncementDrawer } from "@/components/announcement/hooks";
import { IconAlertCircle, IconRefresh } from "@tabler/icons-react";

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
    }
  }, [isOpen, openedOnce]);

  const {
    data: announcementsData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
    refetch,
  } = useInfiniteAnnouncements({
    options: {
      initialLimit: 10,
    },
    enabled: openedOnce,
  });

  // Flatten all announcements from all pages
  const allAnnouncements =
    announcementsData?.pages.flatMap((page) => page.announcements) ?? [];

  // Process announcements with translations and read status
  const processedAnnouncements = useProcessedAnnouncements(
    allAnnouncements as Announcement[],
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
  // Error state component
  const ErrorState = () => (
    <Box p="md">
      <Alert
        icon={<IconAlertCircle size="1rem" />}
        color="red"
        variant="light"
        title={<Trans>Error loading announcements</Trans>}
      >
        <Stack gap="md">
          <Text size="sm">
            <Trans>Failed to get announcements</Trans>
          </Text>
          <Button
            variant="light"
            color="red"
            size="sm"
            leftSection={<IconRefresh size="1rem" />}
            onClick={handleRetry}
            loading={isLoading}
          >
            <Trans>Try Again</Trans>
          </Button>
        </Stack>
      </Alert>
    </Box>
  );

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
        content: "border-0",
        title: "px-3 w-full",
        header: "border-b",
        body: "p-0",
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
              <ErrorState />
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
