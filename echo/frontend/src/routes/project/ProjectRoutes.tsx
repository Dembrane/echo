import { Trans } from "@lingui/react/macro";
import { Alert, Divider, LoadingOverlay, Stack } from "@mantine/core";
import { useMemo } from "react";
import { useParams } from "react-router";
import { ProjectConversationsPanel } from "@/components/conversation/ProjectConversationsPanel";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProjectMemorySection } from "@/components/memory/ProjectMemorySection";
import {
	useProjectById,
	useVerificationTopicsQuery,
} from "@/components/project/hooks";
import ProjectBasicEdit from "@/components/project/ProjectBasicEdit";
import { ProjectDangerZone } from "@/components/project/ProjectDangerZone";
import { ProjectExportSection } from "@/components/project/ProjectExportSection";
import { ProjectMoveWorkspace } from "@/components/project/ProjectMoveWorkspace";
import { ProjectPortalEditor } from "@/components/project/ProjectPortalEditor";
import { ProjectUploadSection } from "@/components/project/ProjectUploadSection";
import {
	ProjectAccess,
	ProjectUsage,
} from "@/components/project/ProjectUsageAndSharing";
import { WebhookSection } from "@/components/project/webhooks/WebhookSettingsCard";
import { FeatureGate } from "@/components/workspace/FeatureGate";
import { ENABLE_WEBHOOKS } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { getProjectTranscriptsLink } from "@/lib/api";
import type { Tier } from "@/lib/tiers";

export const ProjectConversationsRoute = () => {
	const { projectId, workspaceId } = useParams();

	if (!projectId) return null;

	return (
		<PageContainer width="xl">
			<ProjectConversationsPanel
				projectId={projectId}
				workspaceId={workspaceId}
				showUpload
			/>
		</PageContainer>
	);
};

export const ProjectSettingsRoute = () => {
	const { projectId } = useParams();
	const query = useMemo(
		() => ({
			fields: [
				"id",
				"name",
				"context",
				"visibility",
				"workspace_id",
				"updated_at",
				"language",
				"is_conversation_allowed",
				"default_conversation_ask_for_participant_name",
			],
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

			{/* Usage and sharing moved to its own tab (2026-04-24) —
			    /projects/:id/access — so Project Settings stays focused on
			    editing the project itself. The ProjectAccessRoute below
			    owns the Usage & sharing surface. */}

			{projectQuery.data && (
				<>
					{/*
          {projectId && (
            <>
              <Divider />
              <ProjectConversationStatusSection projectId={projectId} />
            </>
          )} */}

					<Divider />
					{projectId && <ProjectMemorySection projectId={projectId} />}

					<Divider />
					<ProjectMoveWorkspace project={projectQuery.data} />

					<Divider />
					<ProjectDangerZone project={projectQuery.data} />
				</>
			)}
		</Stack>
	);
};

export const ProjectUploadRoute = () => {
	const { projectId } = useParams();

	if (!projectId) return null;

	return (
		<PageContainer>
			<ProjectUploadSection projectId={projectId} />
		</PageContainer>
	);
};

export const ProjectIntegrationsRoute = () => {
	const { projectId } = useParams();
	const { workspace, workspaceId } = useWorkspace();
	const query = useMemo(
		() => ({
			fields: ["id", "name", "is_conversation_allowed"],
		}),
		[],
	);
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		// @ts-expect-error narrowed fields are enough for this route
		query,
	});

	if (!projectId) return null;

	// Webhooks are a workspace admin surface (workspace:webhooks policy):
	// members never see the section, and below the changemaker tier the
	// FeatureGate placeholder renders instead of the live section, so no
	// webhook request is ever sent for callers the backend would 403.
	const isWorkspaceAdmin =
		workspace?.role === "admin" || workspace?.role === "owner";

	return (
		<PageContainer>
			<Stack gap="3rem" className="relative">
				{projectQuery.isLoading && <LoadingOverlay visible />}
				{projectQuery.isError && (
					<Alert variant="outline" color="red">
						<Trans>Error loading project</Trans>
					</Alert>
				)}
				{projectQuery.data && (
					<ProjectExportSection
						exportLink={getProjectTranscriptsLink(projectId)}
						projectName={projectQuery.data.name}
						project={projectQuery.data}
					/>
				)}
				{!ENABLE_WEBHOOKS && (
					<>
						<Divider />
						<Alert variant="light">
							<Trans>Webhooks are not enabled for this environment.</Trans>
						</Alert>
					</>
				)}
				{ENABLE_WEBHOOKS && isWorkspaceAdmin && workspace && workspaceId && (
					<>
						<Divider />
						<FeatureGate
							currentTier={workspace.tier as Tier}
							requiredTier="changemaker"
							featureName="Webhooks"
							benefit="Send conversation and report events to your own systems."
							canRequestUpgrade={isWorkspaceAdmin}
							workspaceId={workspaceId}
						>
							<WebhookSection projectId={projectId} />
						</FeatureGate>
					</>
				)}
			</Stack>
		</PageContainer>
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
				"default_conversation_ask_for_participant_email",
				"default_conversation_description",
				"default_conversation_finish_text",
				"default_conversation_title",
				"default_conversation_transcript_prompt",
				"default_conversation_tutorial_slug",
				"get_reply_mode",
				"get_reply_prompt",
				"is_get_reply_enabled",
				"is_verify_enabled",
				"is_verify_on_finish_enabled",
				"selected_verification_key_list",
				"is_project_notification_subscription_allowed",
				"anonymize_transcripts",
				"enable_ai_title_and_tags",
				"conversation_title_prompt",
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
	const verificationTopicsQuery = useVerificationTopicsQuery(projectId);

	const isLoading = projectQuery.isLoading || verificationTopicsQuery.isLoading;
	const isError = projectQuery.isError || verificationTopicsQuery.isError;

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
			{isLoading && <LoadingOverlay visible />}
			{isError && (
				<Alert variant="outline" color="red">
					<Trans>Error loading project</Trans>
				</Alert>
			)}

			{project && verificationTopicsQuery.data && !isLoading && (
				<ProjectPortalEditor
					project={project}
					verificationTopics={verificationTopicsQuery.data}
					isVerificationTopicsLoading={verificationTopicsQuery.isLoading}
				/>
			)}
		</Stack>
	);
};

export const ProjectAccessRoute = () => {
	const { projectId } = useParams();
	const query = useMemo(
		() => ({
			fields: ["id", "name", "visibility"],
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
			{projectQuery.data && projectId && (
				<ProjectAccess
					projectId={projectId}
					visibility={
						(projectQuery.data.visibility as "workspace" | "private") ??
						"workspace"
					}
				/>
			)}
		</Stack>
	);
};

export const ProjectUsageRoute = () => {
	const { projectId } = useParams();

	return (
		<Stack
			gap="3rem"
			className="relative"
			px={{ base: "1rem", md: "2rem" }}
			py={{ base: "2rem", md: "4rem" }}
		>
			{projectId && <ProjectUsage projectId={projectId} />}
		</Stack>
	);
};
