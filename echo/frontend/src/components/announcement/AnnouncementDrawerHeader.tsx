import { Trans } from "@lingui/react/macro";
import { ActionIcon, Button, Group, Stack, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";

export const AnnouncementDrawerHeader = ({
  unreadCount,
  onClose,
  onMarkAllAsRead,
  isPending,
}: {
  unreadCount: number;
  onClose: () => void;
  onMarkAllAsRead: () => void;
  isPending: boolean;
}) => (
  <Stack justify="space-between" align="flex-start" gap="xs">
    <Group justify="space-between" align="center" w="100%">
      <Text fw={500} size="lg">
        <Trans>Announcements</Trans>
      </Text>
      <ActionIcon
        variant="transparent"
        onClick={onClose}
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
        onClick={onMarkAllAsRead}
        disabled={unreadCount === 0 || isPending}
        loading={isPending}
        className={`${unreadCount === 0 ? "ml-auto hidden" : ""}`}
      >
        <Trans>Mark all read</Trans>
      </Button>
    </Group>
  </Stack>
);
