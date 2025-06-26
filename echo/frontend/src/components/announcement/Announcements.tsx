import {
  ActionIcon,
  Box,
  Indicator,
  ScrollArea,
  Stack,
  Text,
  Loader,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconSpeakerphone } from "@tabler/icons-react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Drawer } from "../common/Drawer";
import { AnnouncementItem } from "./AnnouncementItem";
import {
  useAnnouncements,
  useMarkAnnouncementAsReadMutation,
  useCurrentUser,
} from "@/lib/query";
import { useLanguage } from "@/hooks/useLanguage";
import { AnnouncementSkeleton } from "./AnnouncementSkeleton";
import { AnnouncementDrawerHeader } from "./AnnouncementDrawerHeader";
import { useProcessedAnnouncements } from "@/hooks/useProcessedAnnouncements";

export const Announcements = () => {
  const [opened, { open, close }] = useDisclosure(false);
  const { data: announcements = [], isLoading, error } = useAnnouncements();
  const { language } = useLanguage();
  const { data: currentUser } = useCurrentUser();
  const markAsReadMutation = useMarkAnnouncementAsReadMutation();
  const [markingAsReadId, setMarkingAsReadId] = useState<string | null>(null);

  // Process announcements with translations and read status
  const processedAnnouncements = useProcessedAnnouncements(
    announcements as Announcement[],
    language,
  );

  const unreadAnnouncements = processedAnnouncements.filter((a) => !a.read);
  const unreadCount = unreadAnnouncements.length;

  const handleMarkAsRead = async (id: string) => {
    if (!currentUser?.id) {
      console.error("No current user found");
      return;
    }

    setMarkingAsReadId(id);

    try {
      await markAsReadMutation.mutateAsync({
        announcementIds: [id],
        userId: currentUser.id,
      });
    } catch (error) {
      console.error("Failed to mark announcement as read:", error);
    } finally {
      setMarkingAsReadId(null);
    }
  };

  const handleMarkAllAsRead = async () => {
    if (!currentUser?.id) {
      console.error("No current user found");
      return;
    }

    try {
      // Extract all unread announcement IDs
      const unreadIds = unreadAnnouncements.map(
        (announcement) => announcement.id,
      );

      // Mark all unread announcements as read in one call
      await markAsReadMutation.mutateAsync({
        announcementIds: unreadIds as string[],
        userId: currentUser.id,
      });
    } catch (error) {
      console.error("Failed to mark all announcements as read:", error);
    }
  };

  if (error) {
    console.error("Error loading announcements:", error);
  }

  return (
    <>
      <Box onClick={open} className="cursor-pointer">
        <Indicator
          inline
          offset={4}
          color="blue"
          label={unreadCount}
          size={20}
          disabled={unreadCount === 0}
          withBorder
        >
          <ActionIcon color="gray" variant="transparent">
            {isLoading ? (
              <Loader size="xs" />
            ) : (
              <IconSpeakerphone className="rotate-[340deg]" />
            )}
          </ActionIcon>
        </Indicator>
      </Box>

      <Drawer
        opened={opened}
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
                processedAnnouncements.map((announcement, index) => (
                  <AnnouncementItem
                    key={announcement.id}
                    announcement={announcement}
                    onMarkAsRead={handleMarkAsRead}
                    index={index}
                    isMarkingAsRead={markingAsReadId === announcement.id}
                  />
                ))
              )}
            </Stack>
          </ScrollArea>
        </Stack>
      </Drawer>
    </>
  );
};
