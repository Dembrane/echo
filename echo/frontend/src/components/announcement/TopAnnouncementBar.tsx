import {
  Box,
  Group,
  Text,
  useMantineTheme,
  ActionIcon,
  ThemeIcon,
} from "@mantine/core";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";
import { useLatestAnnouncement, useMarkAsReadMutation } from "@/lib/query";
import { theme } from "@/theme";
import { useState } from "react";
import { useAnnouncementDrawer } from "@/hooks/useAnnouncementDrawer";
import { useLanguage } from "@/hooks/useLanguage";
import { Markdown } from "@/components/common/Markdown";
import { getTranslatedContent } from "@/hooks/useProcessedAnnouncements";
import { toast } from "@/components/common/Toaster";
import { t } from "@lingui/core/macro";

export function TopAnnouncementBar() {
  const theme = useMantineTheme();
  const { data: announcement, isLoading } = useLatestAnnouncement();
  const markAsReadMutation = useMarkAsReadMutation();
  const [isClosed, setIsClosed] = useState(false);
  const { open } = useAnnouncementDrawer();
  const { language } = useLanguage();

  // Check if the announcement has been read by the current user
  // Directus already filters activity data for the current user
  const isRead = announcement?.activity?.some(
    (activity) => activity.read === true,
  );

  // Only show if we have an urgent announcement, it's not closed, and it's not read
  if (
    isLoading ||
    !announcement ||
    announcement.level !== "urgent" ||
    isClosed ||
    isRead
  ) {
    return null;
  }

  const { title } = getTranslatedContent(announcement, language);

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsClosed(true);

    // Mark announcement as read
    if (announcement.id) {
      markAsReadMutation.mutate({
        announcementId: announcement.id,
      });
    }
  };

  const handleBarClick = () => {
    open();
  };

  return (
    <Box
      className="relative flex w-full cursor-pointer items-center justify-center p-3 text-center"
      bg={theme.colors.blue[0]}
      onClick={handleBarClick}
    >
      <Group justify="center" gap="md" wrap="nowrap">
        <ThemeIcon
          size={25}
          variant="transparent"
          color={announcement.level === "urgent" ? "orange" : "blue"}
          radius="xl"
        >
          <IconAlertTriangle size={20} />
        </ThemeIcon>
        <Markdown content={title} className="line-clamp-1" />
      </Group>

      <ActionIcon
        variant="transparent"
        size="sm"
        onClick={handleClose}
        className="absolute right-6"
      >
        <IconX size={16} />
      </ActionIcon>
    </Box>
  );
}
