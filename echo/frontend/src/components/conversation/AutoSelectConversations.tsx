import { useAddChatContextMutation, useDeleteChatContextMutation, useProjectChatContext } from "@/lib/query";
import { Trans } from "@lingui/react/macro";
import { Box, Checkbox, Group, Stack, Text } from "@mantine/core";
import { useParams } from "react-router-dom";

export const AutoSelectConversations = () => {
  const { chatId } = useParams();
  const projectChatContextQuery = useProjectChatContext(chatId ?? "");
  const addChatContextMutation = useAddChatContextMutation();
  const deleteChatContextMutation = useDeleteChatContextMutation();
  // Get the auto_select_bool value from the chat context
  const autoSelect = projectChatContextQuery.data?.auto_select_bool ?? false;
  const handleCheckboxChange = (checked: boolean) => {
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
      <Group justify="space-between" p="md" wrap="nowrap">
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
          color="green"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => handleCheckboxChange(e.currentTarget.checked)}
        />
      </Group>
    </Box>
  );
};