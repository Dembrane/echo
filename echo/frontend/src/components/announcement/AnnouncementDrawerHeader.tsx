import { Trans } from "@lingui/react/macro";
import { ActionIcon, Button, Group, Stack, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useUnreadAnnouncements } from "@/lib/query";

export const AnnouncementDrawerHeader = ({
  onClose,
  onMarkAllAsRead,
  isPending,
}: {
  onClose: () => void;
  onMarkAllAsRead: () => void;
  isPending: boolean;
}) => {
  const { data: unreadCount, isLoading: isLoadingUnread } =
    useUnreadAnnouncements();
  return (
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
        {unreadCount && unreadCount > 0 && (
          <Text size="sm" c="dimmed">
            {unreadCount} <Trans>unread announcements</Trans>
          </Text>
        )}
        {unreadCount && unreadCount > 0 && (
          <Button
            variant="subtle"
            size="xs"
            onClick={onMarkAllAsRead}
            disabled={isPending}
            loading={isPending}
          >
            <Trans>Mark all read</Trans>
          </Button>
        )}
      </Group>
    </Stack>
  );
};
