import { Markdown } from "@/components/common/Markdown";
import { toast } from "@/components/common/Toaster";
import { deleteParticipantConversationChunk } from "@/lib/api";
import { t } from "@lingui/core/macro";
import { ActionIcon, Menu, Paper, Text } from "@mantine/core";
import { IconDotsVertical, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";

const UserChunkMessage = ({
  chunk,
  hide,
}: {
  chunk?: TConversationChunk;
  hide?: boolean;
}) => {
  const { projectId, conversationId } = useParams();
  const queryClient = useQueryClient();

  const deleteChunkMutation = useMutation({
    mutationFn: ({
      projectId,
      conversationId,
      chunkId,
    }: {
      projectId: string;
      conversationId: string;
      chunkId: string;
    }) =>
      deleteParticipantConversationChunk(
        projectId ?? "",
        conversationId ?? "",
        chunkId ?? "",
      ),
    onMutate: (vars) => {
      queryClient.cancelQueries({
        queryKey: ["participant", "conversation_chunks", conversationId ?? ""],
      });
      const previousValue = queryClient.getQueryData([
        "participant",
        "conversation_chunks",
        conversationId ?? "",
      ]);
      queryClient.setQueryData(
        ["participant", "conversation_chunks", conversationId ?? ""],

        (old: TConversationChunk[] | undefined) =>
          old?.filter((c) => c.id !== vars.chunkId),
      );
      return previousValue;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["participant", "conversation_chunks", conversationId ?? ""],
      });
      toast.success(t`Deleted successfully`);
    },
    onError: (error, _vars, context) => {
      // Restore the previous data if the mutation fails
      queryClient.setQueryData(
        ["participant", "conversation_chunks", conversationId ?? ""],
        context,
      );
      console.error("Error deleting chunk:", error);
      toast.error(t`Failed to delete response`);
    },
  });

  if (!chunk) return <></>;
  if (hide) return <></>;

  const handleDelete = () => {
    deleteChunkMutation.mutate({
      projectId: projectId ?? "",
      conversationId: conversationId ?? "",
      chunkId: chunk.id,
    });
  };

  return (
    <div className="items-baseline flex justify-end gap-2">
      <div>
        <ActionIcon
          size={30}
          variant="default"
          c="red"
          disabled={deleteChunkMutation.isPending}
          className="rounded-full border-0"
          onClick={handleDelete}
        >
          <IconTrash style={{ width: "70%", height: "70%" }}/>
        </ActionIcon>
      </div>
      <Paper className="my-2 rounded-t-xl rounded-bl-xl border-0 bg-gray-100 p-4">
        <Text className="prose text-sm">
          {chunk.transcript == null && (
            <Markdown content={t`*Transcription in progress.*`} />
          )}
          <Markdown content={chunk.transcript ?? ""} />
        </Text>
      </Paper>
    </div>
  );
};

export default UserChunkMessage;
