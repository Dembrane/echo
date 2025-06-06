import { Trans } from "@lingui/react/macro";
import {
  Divider,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  Title,
  Button,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import { useParams } from "react-router-dom";
import {
  useConversationById,
  useConversationChunks,
  useProjectById,
} from "@/lib/query";
import { ConversationEdit } from "@/components/conversation/ConversationEdit";
import { ConversationDangerZone } from "@/components/conversation/ConversationDangerZone";
import { finishConversation, generateConversationSummary } from "@/lib/api";
import { IconRefresh } from "@tabler/icons-react";
import { t } from "@lingui/core/macro";
import { Markdown } from "@/components/common/Markdown";
import { useMutation } from "@tanstack/react-query";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import { useClipboard } from "@mantine/hooks";
import { toast } from "@/components/common/Toaster";

export const ProjectConversationOverviewRoute = () => {
  const { conversationId, projectId } = useParams();

  const conversationQuery = useConversationById({
    conversationId: conversationId ?? "",
  });
  const conversationChunksQuery = useConversationChunks(conversationId ?? "");
  const projectQuery = useProjectById({ projectId: projectId ?? "" });

  const useHandleGenerateSummaryManually = useMutation({
    mutationFn: async () => {
      const response = await generateConversationSummary(conversationId ?? "");
      toast.info(
        t`The summary is being regenerated. Please wait for the new summary to be available.`,
      );
      return response;
    },
    onSuccess: () => {
      conversationQuery.refetch();
    },
    onError: () => {
      toast.error(t`Failed to regenerate the summary. Please try again later.`);
    },
  });

  const clipboard = useClipboard();

  return (
    <Stack gap="3rem" className="relative" px="2rem" pt="2rem" pb="2rem">
      <LoadingOverlay visible={conversationQuery.isLoading} />
      {conversationChunksQuery.data &&
        conversationChunksQuery.data?.length > 0 && (
          <Stack gap="1.5rem">
            <>
              <Group>
                <Title order={2}>
                  {(conversationQuery.data?.summary ||
                    (conversationQuery.data?.source &&
                      !conversationQuery.data.source
                        .toLowerCase()
                        .includes("upload"))) && <Trans>Summary</Trans>}
                </Title>
                <Group gap="sm">
                  {conversationQuery.data?.summary && (
                    <CopyIconButton
                      size={22}
                      onCopy={() => {
                        clipboard.copy(conversationQuery.data?.summary ?? "");
                      }}
                      copied={clipboard.copied}
                      copyTooltip={t`Copy Summary`}
                    />
                  )}
                  {conversationQuery.data?.summary && (
                    <Tooltip label={t`Regenerate Summary`}>
                      <ActionIcon
                        variant="transparent"
                        onClick={() =>
                          window.confirm(
                            t`Are you sure you want to regenerate the summary? You will lose the current summary.`,
                          ) && useHandleGenerateSummaryManually.mutate()
                        }
                      >
                        <IconRefresh size={22} color="gray" />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              </Group>

              <Markdown
                content={
                  conversationQuery.data?.summary ??
                  (useHandleGenerateSummaryManually.data &&
                  "summary" in useHandleGenerateSummaryManually.data
                    ? useHandleGenerateSummaryManually.data.summary
                    : "")
                }
              />

              {!conversationQuery.isFetching &&
                !conversationQuery.data?.summary &&
                conversationQuery.data?.source &&
                !conversationQuery.data.source
                  .toLowerCase()
                  .includes("upload") && (
                  <div>
                    <Button
                      variant="outline"
                      className="-mt-[2rem]"
                      loading={useHandleGenerateSummaryManually.isPending}
                      onClick={() => {
                        useHandleGenerateSummaryManually.mutate();
                      }}
                    >
                      {t`Generate Summary`}
                    </Button>
                  </div>
                )}

              <Divider />
            </>
          </Stack>
        )}

      {conversationQuery.data && projectQuery.data && (
        <>
          <Stack gap="1.5rem">
            <ConversationEdit
              key={conversationQuery.data.id}
              conversation={conversationQuery.data}
              projectTags={projectQuery.data.tags}
            />
          </Stack>

          <Divider />

          <Stack gap="1.5rem">
            <ConversationDangerZone conversation={conversationQuery.data} />
          </Stack>
        </>
      )}
    </Stack>
  );
};
