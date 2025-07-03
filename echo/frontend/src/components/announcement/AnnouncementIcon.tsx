import { ActionIcon, Box, Group, Indicator, Loader, Text } from "@mantine/core";
import { IconSpeakerphone } from "@tabler/icons-react";
import { useLatestAnnouncement, useUnreadAnnouncements } from "./hooks";
import { useLanguage } from "@/hooks/useLanguage";
import { useAnnouncementDrawer } from "@/hooks/useAnnouncementDrawer";
import { getTranslatedContent } from "@/hooks/useProcessedAnnouncements";
import { Markdown } from "@/components/common/Markdown";

export const AnnouncementIcon = () => {
  const { open } = useAnnouncementDrawer();
  const { language } = useLanguage();
  const { data: latestAnnouncement, isLoading: isLoadingLatest } =
    useLatestAnnouncement();
  const { data: unreadCount, isLoading: isLoadingUnread } =
    useUnreadAnnouncements();

  // Get latest urgent announcement message
  const urgentMessage = latestAnnouncement
    ? getTranslatedContent(latestAnnouncement, language).message
    : "";

  // Check if the latest announcement is unread
  const isUrgentUnread = latestAnnouncement
    ? !latestAnnouncement.activity?.some(
        (activity: any) => activity.read === true,
      )
    : false;

  const isLoading = isLoadingLatest || isLoadingUnread;

  return (
    <Group onClick={open} gap="sm" align="center" className="cursor-pointer">
      <Box>
        <Indicator
          inline
          offset={4}
          color="blue"
          label={
            <Box px={2} className="text-xs">
              {unreadCount || 0}
            </Box>
          }
          size={20}
          disabled={(unreadCount || 0) === 0}
          withBorder
        >
          <ActionIcon color="gray" variant="transparent">
            {isLoading ? (
              <Loader size="xs" />
            ) : (
              <IconSpeakerphone className="me-1 rotate-[330deg]" />
            )}
          </ActionIcon>
        </Indicator>
      </Box>

      {isUrgentUnread && urgentMessage && (
        <Box
          className="hidden max-w-xs [mask-image:linear-gradient(to_right,black_80%,transparent)] md:block"
          style={{ maxWidth: "400px" }}
        >
          <Markdown content={urgentMessage} className="truncate" />
        </Box>
      )}
    </Group>
  );
};
