import {
  Box,
  Button,
  Group,
  Stack,
  Text,
  useMantineTheme,
  ThemeIcon,
} from "@mantine/core";
import {
  IconChecks,
  IconChevronDown,
  IconChevronUp,
  IconInfoCircle,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState, forwardRef } from "react";
import { Markdown } from "@/components/common/Markdown";

type Announcement = {
  id: string;
  title: string;
  message: string;
  created_at: string | Date | null | undefined;
  expires_at?: string | Date | null | undefined;
  read?: boolean | null;
  level: "info" | "urgent";
};

interface AnnouncementItemProps {
  announcement: Announcement;
  onMarkAsRead: (id: string) => void;
  index: number;
}

// TODO: need to improve this function in future according to requirements
const formatDate = (date: string | Date | null | undefined): string => {
  if (!date) return "";

  // Convert string to Date object if needed
  const dateObj = typeof date === "string" ? new Date(date) : date;

  // Check if the date is valid
  if (isNaN(dateObj.getTime())) return "";

  const now = new Date();
  const diffInHours = Math.floor(
    (now.getTime() - dateObj.getTime()) / (1000 * 60 * 60),
  );

  if (diffInHours < 1) return t`Just now`;
  if (diffInHours < 24) return t`${diffInHours}h ago`;

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return t`${diffInDays}d ago`;

  return dateObj.toLocaleDateString();
};

export const AnnouncementItem = forwardRef<
  HTMLDivElement,
  AnnouncementItemProps
>(({ announcement, onMarkAsRead, index }, ref) => {
  const theme = useMantineTheme();
  const [showMore, setShowMore] = useState(false);
  const [showReadMoreButton, setShowReadMoreButton] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messageRef.current) {
      setShowReadMoreButton(
        messageRef.current.scrollHeight !== messageRef.current.clientHeight,
      );
    }
  }, []);

  return (
    <Box
      ref={ref}
      className={`group border-b border-gray-100 p-4 transition-all duration-200 hover:bg-blue-50 ${index === 0 ? "border-t-0" : ""} ${
        !announcement.read
          ? "border-l-4 border-l-blue-500"
          : "border-l-4 border-l-gray-50/50 bg-gray-50/50"
      }`}
    >
      <Stack gap="xs">
        <Group gap="sm" align="flex-start">
          {
            <ThemeIcon
              size={25}
              variant="light"
              color={announcement.level === "urgent" ? "orange" : "blue"}
              radius="xl"
            >
              {announcement.level === "urgent" ? (
                <IconAlertTriangle size={17} />
              ) : (
                <IconInfoCircle size={20} />
              )}
            </ThemeIcon>
          }
          <Stack gap="xs" style={{ flex: 1 }}>
            <Group justify="space-between" align="center">
              <div style={{ flex: 1 }}>
                <Markdown content={announcement.title} />
              </div>

              <Group gap="sm" align="center">
                <Text size="xs" c="dimmed">
                  {formatDate(announcement.created_at)}
                </Text>

                {/* this part needs a second look */}
                {!announcement.read && (
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      backgroundColor: theme.colors.blue[6],
                    }}
                  />
                )}
                {/* this part needs a second look */}
              </Group>
            </Group>

            <Text lineClamp={showMore ? undefined : 2} ref={messageRef}>
              <Markdown
                content={announcement.message}
                className="text-sm text-gray-600"
              />
            </Text>

            <Group justify="space-between" align="center">
              {showReadMoreButton && (
                <Button
                  variant="transparent"
                  color="gray"
                  size="xs"
                  className="hover:underline"
                  p={0}
                  onClick={() => setShowMore(!showMore)}
                >
                  {showMore ? (
                    <Group gap="xs">
                      <Trans>Show less</Trans>
                      <IconChevronUp size={14} />
                    </Group>
                  ) : (
                    <Group gap="xs">
                      <Trans>Show more</Trans>
                      <IconChevronDown size={14} />
                    </Group>
                  )}
                </Button>
              )}

              <Box ml="auto">
                {!announcement.read && (
                  <Button
                    variant="transparent"
                    size="xs"
                    color="gray"
                    className="hover:underline"
                    onClick={() => {
                      onMarkAsRead(announcement.id);
                    }}
                  >
                    <Trans>Mark as read</Trans>
                  </Button>
                )}
              </Box>
            </Group>
          </Stack>
        </Group>
      </Stack>
    </Box>
  );
});

AnnouncementItem.displayName = "AnnouncementItem";
