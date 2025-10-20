import { Trans } from "@lingui/react/macro";
import { Alert, Divider, LoadingOverlay, Stack } from "@mantine/core";
import { useMemo } from "react";
import { useParams } from "react-router";
import { useProjectById } from "@/components/project/hooks";
import ProjectBasicEdit from "@/components/project/ProjectBasicEdit";
import { ProjectDangerZone } from "@/components/project/ProjectDangerZone";
import { ProjectExportSection } from "@/components/project/ProjectExportSection";
import { ProjectPortalEditor } from "@/components/project/ProjectPortalEditor";
import { ProjectUploadSection } from "@/components/project/ProjectUploadSection";
import { getProjectTranscriptsLink } from "@/lib/api";

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
					<ProjectUploadSection projectId={projectId ?? ""} />

					<Divider />
					<ProjectExportSection
						exportLink={getProjectTranscriptsLink(projectId ?? "")}
						projectName={projectQuery.data.name}
					/>

					{/* 
          {projectId && (
            <>
              <Divider />
              <ProjectConversationStatusSection projectId={projectId} />
            </>
          )} */}

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
	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
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
