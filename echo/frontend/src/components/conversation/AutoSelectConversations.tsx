import { useAddChatContextMutation, useConversationsByProjectId, useDeleteChatContextMutation } from "./hooks";
import { useProjectChatContext } from "@/components/chat/hooks";
import { useProjectById } from "@/components/project/hooks";
import { Trans } from "@lingui/react/macro";
import {
  Box,
  Checkbox,
  Group,
  Stack,
  Text,
  Badge,
  Button,
  Alert,
} from "@mantine/core";
import { useParams } from "react-router-dom";
import {
  IconCheck,
  IconLock,
  IconBulb,
  IconInfoCircle,
} from "@tabler/icons-react";
import { t } from "@lingui/core/macro";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { SalesLinks } from "@/lib/links";

export const AutoSelectConversations = () => {
  const { chatId, projectId } = useParams();

  const { data: project } = useProjectById({
    projectId: projectId ?? "",
    query: {
      fields: ["is_enhanced_audio_processing_enabled"],
    },
  });

  const { data: conversations } = useConversationsByProjectId(
    projectId ?? "",
    false,
    true,
    {
      fields: ["is_audio_processing_finished"],
    },
  );

  const projectChatContextQuery = useProjectChatContext(chatId ?? "");
  const addChatContextMutation = useAddChatContextMutation();
  const deleteChatContextMutation = useDeleteChatContextMutation();

  // Get the auto_select_bool value from the chat context
  const autoSelect = projectChatContextQuery.data?.auto_select_bool ?? false;

  const isDisabled = !project?.is_enhanced_audio_processing_enabled;
  const isAvailableButNotEnabled = !autoSelect && !isDisabled;

  // Check if any conversations have completed audio processing
  const hasProcessedConversations = conversations?.some(
    (conversation) => conversation.is_audio_processing_finished,
  );

  console.log(hasProcessedConversations, conversations);

  // Show warning if feature is available but no conversations are processed
  const showProcessingWarning =
    !isDisabled &&
    conversations &&
    conversations.length > 0 &&
    !hasProcessedConversations;

  const handleCheckboxChange = (checked: boolean) => {
    if (isDisabled) {
      return;
    }

    if (checked) {
      addChatContextMutation.mutate({
        chatId: chatId ?? "",
        auto_select_bool: true,
      });
    } else {
      deleteChatContextMutation.mutate({
        chatId: chatId ?? "",
        auto_select_bool: false,
      });
    }
  };

  const enableAutoSelect = () => {
    if (!isDisabled) {
      addChatContextMutation.mutate({
        chatId: chatId ?? "",
        auto_select_bool: true,
      });
    } else {
      try {
        analytics.trackEvent(events.AUTO_SELECT_CONTACT_SALES);
      } catch (error) {
        console.warn("Analytics tracking failed:", error);
      }
      window.open(SalesLinks.AUTO_SELECT_CONTACT, "_blank");
    }
  };

  // Feature state indicator
  const renderFeatureIndicator = () => {
    if (autoSelect) {
      return (
        <Badge
          color="green"
          variant="light"
          leftSection={<IconCheck size={14} />}
        >
          <Trans>Enabled</Trans>
        </Badge>
      );
    } else if (isAvailableButNotEnabled) {
      return (
        <Badge
          color="blue"
          variant="light"
          leftSection={<IconBulb size={14} />}
        >
          <Trans>Available</Trans>
        </Badge>
      );
    } else {
      return (
        <Badge
          color="gray"
          variant="light"
          leftSection={<IconLock size={14} />}
        >
          <Trans>Upgrade</Trans>
        </Badge>
      );
    }
  };

  return (
    <Box className="relative cursor-pointer border border-gray-200 hover:bg-gray-50">
      <Badge
        className="absolute right-0 top-0 -translate-y-1/3 translate-x-1/3"
        color="red"
        size="sm"
      >
        <Trans>New</Trans>
      </Badge>

      <Group
        justify="space-between"
        p="md"
        wrap="nowrap"
        className={isDisabled ? "opacity-50" : ""}
      >
        <Stack gap="xs" style={{ flexGrow: 1 }}>
          <Group gap="xs">
            <Text className="font-medium">
              <Trans>Auto-select</Trans>
            </Text>

            {renderFeatureIndicator()}
          </Group>
          <Text size="xs" c="gray.6">
            <Trans>
              Automatically includes relevant conversations for analysis without
              manual selection
            </Trans>
          </Text>
        </Stack>
        <Checkbox
          size="md"
          checked={autoSelect}
          disabled={isDisabled}
          color="green"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => handleCheckboxChange(e.currentTarget.checked)}
        />
      </Group>

      {showProcessingWarning && (
        <Alert
          color="yellow"
          icon={<IconInfoCircle size={16} />}
          title={<Trans>Audio Processing In Progress</Trans>}
          className="border-t border-yellow-200 bg-yellow-50 p-3"
        >
          <Text size="xs">
            <Trans>
              Some conversations are still being processed. Auto-select will
              work optimally once audio processing is complete.
            </Trans>
          </Text>
        </Alert>
      )}

      {isDisabled && (
        <Box className="border-t border-gray-200 bg-gray-50 p-4">
          <Stack gap="sm">
            <Text size="xs" fw={500}>
              <Trans>
                Upgrade to unlock Auto-select and analyze 10x more conversations
                in half the time—no more manual selection, just deeper insights
                instantly.
              </Trans>
            </Text>
            <Button
              size="xs"
              onClick={enableAutoSelect}
              leftSection={<IconLock size={14} />}
            >
              <Trans>Contact sales</Trans>
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
};
