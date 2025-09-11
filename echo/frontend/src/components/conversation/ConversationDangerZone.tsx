import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack } from "@mantine/core";
import { useParams } from "react-router";
import { IconDownload, IconTrash } from "@tabler/icons-react";
import { useDeleteConversationByIdMutation } from "./hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { MoveConversationButton } from "@/components/conversation/MoveConversationButton";
import { api, getConversationContentLink } from "@/lib/api";
import { UploadConversationDropzone } from "../dropzone/UploadConversationDropzone";

export const ConversationDangerZone = ({
  conversation,
}: {
  conversation: Conversation;
}) => {
  const deleteConversationByIdMutation = useDeleteConversationByIdMutation();
  const navigate = useI18nNavigate();
  const { projectId } = useParams();

  const handleDelete = () => {
    if (
      window.confirm(
        t`Are you sure you want to delete this conversation? This action cannot be undone.`,
      )
    ) {
      deleteConversationByIdMutation.mutate(conversation.id);
      navigate(`/projects/` + projectId + "/overview");
    }
  };

  return (
    <Stack gap="3rem">
      <Stack gap="1.5rem">
        <div className="flex">
          <Stack gap="1rem">
            <MoveConversationButton conversation={conversation} />

            <Button
              variant="outline"
              rightSection={<IconDownload size={16} />}
              component="a"
              target="_blank"
              href={getConversationContentLink(conversation.id)}
            >
              <Group>
                <Trans>Download Audio</Trans>
              </Group>
            </Button>

            <Button
              onClick={handleDelete}
              color="red"
              variant="outline"
              rightSection={<IconTrash size={16} />}
            >
              <Trans>Delete Conversation</Trans>
            </Button>
          </Stack>
        </div>
      </Stack>
    </Stack>
  );
};
