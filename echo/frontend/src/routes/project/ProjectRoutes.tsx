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
	const query = useMemo(
		() => ({
			fields: ["id", "name", "context", "updated_at", "language"],
		}),
		[],
	);
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		// @ts-expect-error tags field structure not properly typed in Directus SDK
		query,
	});
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
	const query = useMemo(
		() => ({
			deep: {
				tags: {
					_sort: "sort",
				},
			},
			fields: [
				"id",
				"updated_at",
				"language",
				"default_conversation_ask_for_participant_name",
				"default_conversation_description",
				"default_conversation_finish_text",
				"default_conversation_title",
				"default_conversation_transcript_prompt",
				"default_conversation_tutorial_slug",
				"get_reply_mode",
				"get_reply_prompt",
				"is_get_reply_enabled",
				"is_project_notification_subscription_allowed",
				{
					tags: ["id", "created_at", "text", "sort"],
				},
			],
		}),
		[],
	);
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		// @ts-expect-error tags field structure not properly typed in Directus SDK
		query,
	});

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
