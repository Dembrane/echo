import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { CloseableAlert } from "@/components/common/ClosableAlert";
import { ProjectAnalysisRunStatus } from "@/components/project/ProjectAnalysisRunStatus";
import { ViewExpandedCard } from "@/components/view/View";
import { Icons } from "@/icons";
import { useProjectById } from "@/components/project/hooks";
import {
  useGenerateProjectLibraryMutation,
  useProjectViews,
} from "@/components/library/hooks";
import { useLatestProjectAnalysisRunByProjectId } from "@/components/project/hooks";
import { useConversationsByProjectId } from "@/components/conversation/hooks";
import { useLanguage } from "@/hooks/useLanguage";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  Alert,
  Button,
  Collapse,
  Container,
  Divider,
  Group,
  LoadingOverlay,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconClock,
  IconInfoCircle,
  IconPlus,
  IconRefresh,
  IconSortAscending,
} from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useParams } from "react-router-dom";
import { CreateView } from "@/components/view/CreateViewForm";
import { DummyViews } from "../../../components/view/DummyViews";

type SortBy = "relevance" | "default";

export const ProjectLibraryRoute = () => {
  const { projectId } = useParams();

  const { iso639_1 } = useLanguage();

  const viewsQuery = useProjectViews(projectId ?? "");
  const projectQuery = useProjectById({
    projectId: projectId ?? "",
  });
  const conversationsQuery = useConversationsByProjectId(
    projectId ?? "",
    false,
  );
  const requestProjectLibraryMutation = useGenerateProjectLibraryMutation();
  const [sortBy, setSortBy] = useState<SortBy>("relevance");
  const toggleSort = useCallback(() => {
    setSortBy(sortBy === "default" ? "relevance" : "default");
  }, [sortBy, setSortBy]);
  const [parent] = useAutoAnimate();

  const latestRunQuery = useLatestProjectAnalysisRunByProjectId(
    projectId ?? "",
  );

  const latestRun = latestRunQuery.data ?? null;

  const [opened, { toggle, close }] = useDisclosure(false);

  if (conversationsQuery.isLoading) {
    return (
      <Container>
        <Stack className="relative h-[400px] px-2 py-6">
          <LoadingOverlay visible />
        </Stack>
      </Container>
    );
  }

  const viewsExist =
    viewsQuery && viewsQuery.data && viewsQuery.data.length > 0;

  const handleCreateLibrary = async () => {
    if (
      window.confirm(
        t`Are you sure you want to generate the library? This will take a while and overwrite your current views and insights.`,
      )
    ) {
      requestProjectLibraryMutation.mutate({
        projectId: projectId ?? "",
        language: iso639_1,
      });
    }
  };

  return (
    <Stack className="relative px-4 py-6">
      <Group justify="space-between">
        <Breadcrumbs
          items={[
            {
              label: (
                <Title order={1}>
                  <Trans>Library</Trans>
                </Title>
              ),
            },
          ]}
        />

        {latestRun ? (
          <Button
            variant="outline"
            leftSection={<IconRefresh />}
            onClick={handleCreateLibrary}
          >
            <Trans>Regenerate Library</Trans>
          </Button>
        ) : (
          <Tooltip
            label={
              requestProjectLibraryMutation.isPending
                ? t`Library creation is in progress`
                : conversationsQuery.data?.length === 0
                  ? t`No conversations available to create library`
                  : // : latestRun?.processing_status === "PROCESSING"
                    //   ? t`Library is currently being processed`
                    null
            }
            disabled={
              !(
                (
                  requestProjectLibraryMutation.isPending ||
                  conversationsQuery.data?.length === 0
                )
                // ||
                // latestRun?.processing_status === "PROCESSING"
              )
            }
          >
            <Button
              leftSection={<IconPlus />}
              onClick={handleCreateLibrary}
              loading={requestProjectLibraryMutation.isPending}
              disabled={
                // TODO: this should really be a server-side check
                requestProjectLibraryMutation.isPending ||
                conversationsQuery.data?.length === 0
                // ||
                // latestRun?.processing_status === "PROCESSING"
              }
            >
              <Trans>Create Library</Trans>
            </Button>
          </Tooltip>
        )}
      </Group>

      <Divider />

      <ProjectAnalysisRunStatus projectId={projectId ?? ""} />

      {conversationsQuery.data?.length === 0 && (
        <CloseableAlert variant="light" icon={<IconInfoCircle />}>
          <Text>
            <Trans>
              No conversations available to create library. Please add some
              conversations to get started.
            </Trans>
          </Text>
        </CloseableAlert>
      )}

      {!latestRun &&
        conversationsQuery.data?.length &&
        conversationsQuery.data?.length > 0 && (
          <CloseableAlert>
            <Trans>
              This is your project library. Currently,
              {conversationsQuery.data?.length} conversations are waiting to be
              processed.
            </Trans>
          </CloseableAlert>
        )}

      <Group justify="space-between">
        <Title order={2}>
          <Trans>Your Views</Trans>
        </Title>
        <Button
          leftSection={<IconPlus />}
          onClick={toggle}
          disabled={
            !(
              latestRun
              // && latestRun.processing_status === "DONE"
            )
          }
        >
          <Trans>Create View</Trans>
        </Button>
      </Group>

      <Collapse in={opened}>
        <CreateView projectId={projectId ?? ""} onClose={close} />
      </Collapse>

      <Stack>
        {!viewsExist && <DummyViews />}
        {viewsQuery.data &&
          viewsQuery.data.map((v) => <ViewExpandedCard key={v.id} data={v} />)}
      </Stack>
    </Stack>
  );
};
