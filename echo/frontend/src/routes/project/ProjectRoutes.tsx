import { Trans } from "@lingui/react/macro";
import ProjectBasicEdit from "@/components/project/ProjectBasicEdit";
import { ProjectDangerZone } from "@/components/project/ProjectDangerZone";
import { ProjectPortalEditor } from "@/components/project/ProjectPortalEditor";
import { getProjectTranscriptsLink } from "@/lib/api";
import { useProjectById } from "@/lib/query";
import {
  Alert,
  Box,
  Button,
  Divider,
  LoadingOverlay,
  Stack,
  Title,
} from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { useParams } from "react-router-dom";
import { useMemo } from "react";
import { UploadConversationDropzone } from "@/components/dropzone/UploadConversationDropzone";

export const ProjectSettingsRoute = () => {
  const { projectId } = useParams();
  const projectQuery = useProjectById({ projectId: projectId ?? "" });

  return (
    <Stack
      gap="3rem"
      className="relative"
      px={{ base: "1rem", md: "2rem" }}
      py={{ base: "2rem", md: "4rem" }}
    >
      {projectQuery.isLoading && <LoadingOverlay visible />}
      {projectQuery.isError && (
        <Alert variant="outline" color="red">
          <Trans>Error loading project</Trans>
        </Alert>
      )}

      {projectQuery.data && <ProjectBasicEdit project={projectQuery.data} />}

      {projectQuery.data && (
        <>
          <Divider />
          <Stack gap="1.5rem">
            <Title order={2}>
              <Trans>Upload</Trans>
            </Title>
            <div>
              <UploadConversationDropzone projectId={projectId ?? ""} />
            </div>
          </Stack>

          <Divider />
          <Stack gap="1.5rem">
            <Title order={2}>
              <Trans>Export</Trans>
            </Title>
            <Box>
              <Button
                component="a"
                href={getProjectTranscriptsLink(projectId ?? "")}
                download={`${projectQuery.data.name ?? "Project"}-Transcripts.zip`}
                rightSection={<IconDownload />}
                variant="outline"
              >
                <Trans>Download All Transcripts</Trans>
              </Button>
            </Box>
          </Stack>
        </>
      )}

      {projectQuery.data && (
        <>
          <Divider />
          <ProjectDangerZone project={projectQuery.data} />
        </>
      )}
    </Stack>
  );
};

export const ProjectPortalSettingsRoute = () => {
  const { projectId } = useParams();
  const projectQuery = useProjectById({ projectId: projectId ?? "" });

  // Memoize the project data to ensure stable reference
  const project = useMemo(
    () => projectQuery.data,
    [projectQuery.data?.id, projectQuery.data?.updated_at],
  );

  return (
    <Stack
      className="relative"
      gap="3rem"
      px={{ base: "1rem", md: "2rem" }}
      py={{ base: "2rem", md: "4rem" }}
    >
      {projectQuery.isLoading && <LoadingOverlay visible />}
      {projectQuery.isError && (
        <Alert variant="outline" color="red">
          <Trans>Error loading project</Trans>
        </Alert>
      )}

      {project && !projectQuery.isLoading && (
        <ProjectPortalEditor project={project} />
      )}
    </Stack>
  );
};
