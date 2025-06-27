import {
  Box,
  Group,
  Text,
  useMantineTheme,
  ActionIcon,
  ThemeIcon,
} from "@mantine/core";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";
import { useLatestAnnouncement } from "@/lib/query";
import { theme } from "@/theme";
import { useState } from "react";
import { useAnnouncementDrawer } from "@/hooks/useAnnouncementDrawer";
import { useLanguage } from "@/hooks/useLanguage";
import { Markdown } from "@/components/common/Markdown";
import { getTranslatedContent } from "@/hooks/useProcessedAnnouncements";

export function TopAnnouncementBar() {
  const theme = useMantineTheme();
  const { data: announcement, isLoading } = useLatestAnnouncement();
  const [isClosed, setIsClosed] = useState(false);
  const { open } = useAnnouncementDrawer();
  const { language } = useLanguage();

  // Only show if we have an urgent announcement and it's not closed
  if (
    isLoading ||
    !announcement ||
    announcement.level !== "urgent" ||
    isClosed
  ) {
    return null;
  }

  const { title } = getTranslatedContent(announcement, language);

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsClosed(true);
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
        <Markdown content={title} />
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
