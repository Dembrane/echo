import { Trans } from "@lingui/react/macro";
import {
  Divider,
  Group,
  LoadingOverlay,
  Stack,
  Title,
  Button,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import { useParams } from "react-router";
import { useProjectById } from "@/components/project/hooks";
import {
  useConversationById,
  useConversationChunks,
} from "@/components/conversation/hooks";
import { ConversationEdit } from "@/components/conversation/ConversationEdit";
import { ConversationDangerZone } from "@/components/conversation/ConversationDangerZone";
import { generateConversationSummary } from "@/lib/api";
import { IconRefresh } from "@tabler/icons-react";
import { t } from "@lingui/core/macro";
import { Markdown } from "@/components/common/Markdown";
import { useMutation } from "@tanstack/react-query";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import { useClipboard } from "@mantine/hooks";
import { toast } from "@/components/common/Toaster";
import { ConversationLink } from "@/components/conversation/ConversationLink";
import { ENABLE_DISPLAY_CONVERSATION_LINKS } from "@/config";

export const ProjectConversationOverviewRoute = () => {
  const { conversationId, projectId } = useParams();

  const conversationQuery = useConversationById({
    conversationId: conversationId ?? "",
  });
  const conversationChunksQuery = useConversationChunks(conversationId ?? "", 10000, ["id"]);
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

  // Determine if summary section should be shown at all
  const showSummarySection =
    conversationQuery.data?.summary ||
    (conversationQuery.data?.source &&
      !conversationQuery.data.source.toLowerCase().includes("upload"));

  return (
    <Stack gap="3rem" className="relative" px="2rem" pt="2rem" pb="2rem">
      <LoadingOverlay visible={conversationQuery.isLoading} />
      {conversationChunksQuery.data &&
        conversationChunksQuery.data?.length > 0 &&
        showSummarySection && (
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
                      size={23}
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
                        <IconRefresh size={23} color="gray" />
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

              {conversationQuery.data?.summary &&
                conversationQuery.data?.is_finished && <Divider />}
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

          {ENABLE_DISPLAY_CONVERSATION_LINKS && (
            <>
              <ConversationLink
                conversation={conversationQuery.data}
                projectId={projectId ?? ""}
              />
              {conversationQuery?.data?.linked_conversations?.length ||
              conversationQuery?.data?.linking_conversations?.length ? (
                <Divider />
              ) : null}
            </>
          )}

          {/* TODO: better design the links component */}
          {/* {conversationQuery?.data?.linked_conversations?.length ||
          conversationQuery?.data?.linking_conversations?.length ? (
            <Stack gap="2.5rem">
              <ConversationLink
                linkingConversations={conversationQuery.data.linking_conversations}
                linkedConversations={conversationQuery.data.linked_conversations}
              />
              <Divider />
            </Stack>
          ) : null} */}

          <Stack gap="1.5rem">
            <ConversationDangerZone conversation={conversationQuery.data} />
          </Stack>
        </>
      )}
    </Stack>
  );
};
