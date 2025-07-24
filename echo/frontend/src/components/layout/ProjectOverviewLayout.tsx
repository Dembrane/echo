import { t } from "@lingui/core/macro";
import { useProjectById } from "@/components/project/hooks";
import { Box, Divider, LoadingOverlay, Stack } from "@mantine/core";
import { useParams } from "react-router-dom";
import { TabsWithRouter } from "./TabsWithRouter";
import { useDocumentTitle } from "@mantine/hooks";
import { ProjectQRCode } from "../project/ProjectQRCode";
import { OngoingConversationsSummaryCard } from "../conversation/OngoingConversationsSummaryCard";
import { OpenForParticipationSummaryCard } from "../conversation/OpenForParticipationSummaryCard";

export const ProjectOverviewLayout = () => {
  const projectId = useParams().projectId;
  const projectQuery = useProjectById({ projectId: projectId ?? "" });

  useDocumentTitle(t`Project Overview | Dembrane`);

  return (
    <Stack className="relative px-2 py-4">
      <LoadingOverlay visible={projectQuery.isLoading} />
      <div className="grid grid-cols-12 place-content-stretch gap-3">
        <Box visibleFrom="lg" className="col-span-6 h-full">
          <ProjectQRCode project={projectQuery.data} />
        </Box>
        <Stack gap="sm" className="col-span-12 h-full lg:col-span-6">
          <OpenForParticipationSummaryCard projectId={projectId ?? ""} />
          <OngoingConversationsSummaryCard projectId={projectId ?? ""} />
        </Stack>
      </div>
      <Divider />
      <TabsWithRouter
        basePath="/projects/:projectId"
        tabs={[
          { value: "portal-editor", label: t`Portal Editor` },
          { value: "overview", label: t`Project Settings` },
        ]}
        loading={projectQuery.isLoading}
      />
    </Stack>
  );
};
