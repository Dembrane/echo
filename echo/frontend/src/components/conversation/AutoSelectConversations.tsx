import {
  useAddChatContextMutation,
  useConversationsByProjectId,
  useDeleteChatContextMutation,
  useProjectById,
  useProjectChatContext,
} from "@/lib/query";
import { Trans } from "@lingui/react/macro";
import { Box, Checkbox, Group, Stack, Text } from "@mantine/core";
import { useParams } from "react-router-dom";

export const AutoSelectConversations = () => {
  const { chatId, projectId } = useParams();

  const { data: project } = useProjectById({
    projectId: projectId ?? "",
    query: {
      fields: ["is_enhanced_audio_processing_enabled"],
    },
  });
  const projectChatContextQuery = useProjectChatContext(chatId ?? "");
  const addChatContextMutation = useAddChatContextMutation();
  const deleteChatContextMutation = useDeleteChatContextMutation();

  // Get the auto_select_bool value from the chat context
  const autoSelect = projectChatContextQuery.data?.auto_select_bool ?? false;

  const isDisabled = !project?.is_enhanced_audio_processing_enabled;

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

  return (
    <Box className="cursor-pointer border border-gray-200 hover:bg-gray-50">
      <Group
        justify="space-between"
        p="md"
        wrap="nowrap"
        className={isDisabled ? "opacity-50" : ""}
      >
        <Stack gap="xs">
          <Text className="font-medium">
            <Trans>Auto-select</Trans>
          </Text>
          <Text size="xs" c="gray.6">
            <Trans>Auto-select sources to add to the chat</Trans>
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
      {isDisabled && (
        <Text size="xs" c="" className="p-4">
          <Trans>
            Auto-selection of context is disabled for this project. Please reach
            out to sales to enable this feature.
          </Trans>
        </Text>
      )}
    </Box>
  );
};
