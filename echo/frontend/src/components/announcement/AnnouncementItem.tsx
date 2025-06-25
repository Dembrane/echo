import {
  ActionIcon,
  Box,
  Button,
  Collapse,
  Group,
  Stack,
  Text,
  useMantineTheme,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconChecks,
  IconChevronDown,
  IconChevronUp,
  IconInfoCircle,
} from "@tabler/icons-react";
import { Trans } from "@lingui/react/macro";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useRef, useState } from "react";

type Announcement = {
  id: number;
  title: string;
  message: string;
  created_at: string;
  expires_at?: string;
  read: boolean;
  level: "info" | "urgent";
};

interface AnnouncementItemProps {
  announcement: Announcement;
  onMarkAsRead: (id: number) => void;
  index: number;
}

export const AnnouncementItem = ({
  announcement,
  onMarkAsRead,
  index,
}: AnnouncementItemProps) => {
  const theme = useMantineTheme();
  const [showMore, setShowMore] = useState(false);
  const [showReadMoreButton, setShowReadMoreButton] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      console.log(ref.current.scrollHeight, ref.current.clientHeight);
      setShowReadMoreButton(
        ref.current.scrollHeight !== ref.current.clientHeight,
      );
    }
  }, []);
  //   }, [announcement.message, showMore]);

  return (
    <Box
      className={`group border-b border-gray-100 p-4 transition-all duration-200 hover:bg-blue-50 ${index === 0 ? "border-t-0" : ""} ${
        !announcement.read
          ? "border-l-4 border-l-blue-500"
          : "border-l-4 border-l-gray-200 bg-gray-50"
      }`}
    >
      <Stack gap="xs">
        <Group gap="sm" align="flex-start">
          {
            <IconInfoCircle
              size={20}
              color={announcement.level === "urgent" ? "orangered" : "gray"}
            />
          }
          <Stack gap="xs" style={{ flex: 1 }}>
            <Group justify="space-between" align="center">
              <Text fw={500}>{announcement.title}</Text>

              <Group gap="sm" align="center">
                <Text size="xs" c="dimmed">
                  {announcement.created_at}
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

            <Text
              size="sm"
              c="dimmed"
              lineClamp={showMore ? undefined : 2}
              ref={ref}
            >
              {announcement.message}
            </Text>

            <Group justify="space-between" align="center">
              {showReadMoreButton && (
                <Button
                  variant="transparent"
                  size="xs"
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

              {/* this part needs a second look */}
              <Box ml="auto">
                {!announcement.read ? (
                  <Button
                    variant="subtle"
                    size="xs"
                    onClick={() => onMarkAsRead(announcement.id)}
                  >
                    <Trans>Mark as read</Trans>
                  </Button>
                ) : (
                  <Group gap="xs">
                    <IconChecks size={16} color="darkturquoise" />
                    <Text size="xs" c="dimmed">
                      <Trans>Marked as read</Trans>
                    </Text>
                  </Group>
                )}
              </Box>
              {/* this part needs a second look */}
            </Group>
          </Stack>
        </Group>
      </Stack>
    </Box>
  );
};
