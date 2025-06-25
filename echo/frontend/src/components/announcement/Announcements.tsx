import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Indicator,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconSpeakerphone, IconX } from "@tabler/icons-react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Drawer } from "../common/Drawer";
import { AnnouncementItem } from "./AnnouncementItem";

import { initialAnnouncements } from "./announcementList";

export const Announcements = () => {
  const [opened, { open, close }] = useDisclosure(false);
  const [announcements, setAnnouncements] = useState(initialAnnouncements);

  const handleMarkAsRead = (id: number) => {
    setAnnouncements((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  };

  const handleMarkAllAsRead = () => {
    setAnnouncements((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const unreadCount = announcements.filter((n) => !n.read).length;

  return (
    <>
      {/* done and checked */}
      <Box onClick={open} className="cursor-pointer">
        <Indicator
          inline
          offset={4}
          color="orange"
          label={unreadCount}
          size={20}
          disabled={unreadCount === 0}
          withBorder
        >
          <ActionIcon color="gray" variant="transparent">
            <IconSpeakerphone style={{ transform: 'rotate(340deg)' }} />
          </ActionIcon>
        </Indicator>
      </Box>

      {/* done and checked */}
      <Drawer
        opened={opened}
        onClose={close}
        position="right"
        // add real title here
        title={
          <Stack justify="space-between" align="flex-start" gap={0}>
            <Group justify="space-between" align="center" w="100%">
              <Text fw={500} size="lg">
                <Trans>Announcements</Trans>
              </Text>
              <ActionIcon
                variant="transparent"
                onClick={close}
                aria-label="Close drawer"
              >
                <IconX size={18} color="gray" />
              </ActionIcon>
            </Group>
            <Group gap="xs" justify="space-between" w="100%">
              {unreadCount > 0 && (
                <Text size="sm" c="dimmed">
                  {unreadCount} <Trans>unread announcements</Trans>
                </Text>
              )}
              <Button
                variant="subtle"
                size="xs"
                onClick={handleMarkAllAsRead}
                disabled={unreadCount === 0}
                className={`${unreadCount === 0 ? "ml-auto" : ""}`}
              >
                <Trans>Mark all read</Trans>
              </Button>
            </Group>
          </Stack>
        }
        classNames={{
          title: "w-full",
          body: "p-0",
        }}
        withCloseButton={false}
      >
        <Stack h="100%">
          <ScrollArea style={{ flex: 1 }}>
            <Stack gap="0">
              {announcements.map((announcement, index) => (
                <AnnouncementItem
                  key={announcement.id}
                  announcement={announcement}
                  onMarkAsRead={handleMarkAsRead}
                  index={index}
                />
              ))}
            </Stack>
          </ScrollArea>
        </Stack>
      </Drawer>
    </>
  );
};
