import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Divider, Stack, Text, Title } from "@mantine/core";
import { useMemo } from "react";
import { useParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { PageContainer } from "@/components/layout/PageContainer";
import { useProjectById } from "@/components/project/hooks";
import { ProjectDangerZone } from "@/components/project/ProjectDangerZone";
import { ProjectExperimentalSection } from "@/components/project/ProjectExperimentalSection";
import { ProjectMoveWorkspace } from "@/components/project/ProjectMoveWorkspace";
import { useSettingsCatalog } from "@/components/project/portal-editor/i18n";
import { WebhookSection } from "@/components/project/webhooks/WebhookSettingsCard";
import { FeatureGate } from "@/components/workspace/FeatureGate";
import { ENABLE_CANVAS, ENABLE_WEBHOOKS } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
import { testId } from "@/lib/testUtils";
import type { Tier } from "@/lib/tiers";

/**
 * Manage, Advanced (ECHO-1060): webhooks (once the Automation page), the experimental
 * switch, moving the project and deleting it (once on General). Each keeps the rules it
 * had: webhooks for workspace admins on a paid tier, the rest as their sections decide.
 */
export const ProjectAdvancedRoute = () => {
	const { projectId } = useParams();
	const ready = useSettingsCatalog();
	const { workspace, workspaceId } = useWorkspace();
	const canEdit = !!workspace && !isReadOnlyRole(workspace.role);
	const query = useMemo(
		() => ({
			fields: [
				"id",
				"name",
				"context",
				"visibility",
				"workspace_id",
				"methodology_version_id",
				"updated_at",
				"language",
				"is_conversation_allowed",
				"is_canvas_enabled",
				"default_conversation_ask_for_participant_name",
			],
		}),
		[],
	);
	const projectQuery = useProjectById({ projectId: projectId ?? "", query });
	// Webhooks are a workspace admin surface (workspace:webhooks policy): members never see
	// the section, and below the changemaker tier the FeatureGate placeholder renders
	// instead, so no webhook request is ever sent for callers the backend would 403.
	const isWorkspaceAdmin =
		workspace?.role === "admin" || workspace?.role === "owner";

	return (
		<PageContainer>
			<Stack gap="xl" {...testId("project-advanced")}>
				<Stack gap="xs" px={{ base: "md", md: "lg" }}>
					<Title order={2}>{ready ? t`Advanced` : null}</Title>
					{ready && (
						<Text size="sm">
							{t`Automation, early features, and moving or deleting this project.`}
						</Text>
					)}
				</Stack>
				{(projectQuery.isLoading || !ready) && <BeautifulLoading />}
				{projectQuery.isError && (
					<ErrorNotice
						error={projectQuery.error}
						title={t`Error loading project`}
					/>
				)}
				{ready && projectId && (
					<Stack gap="xl" {...testId("project-advanced-webhooks")}>
						{!ENABLE_WEBHOOKS && (
							<Alert variant="outline">
								<Trans>Webhooks are not enabled for this environment.</Trans>
							</Alert>
						)}
						{ENABLE_WEBHOOKS && !isWorkspaceAdmin && (
							<Alert variant="outline">
								<Trans>
									Only workspace admins can manage project automation.
								</Trans>
							</Alert>
						)}
						{ENABLE_WEBHOOKS &&
							isWorkspaceAdmin &&
							workspace &&
							workspaceId && (
								<FeatureGate
									currentTier={workspace.tier as Tier}
									requiredTier="changemaker"
									featureName={t`Webhooks`}
									canRequestUpgrade={isWorkspaceAdmin}
									workspaceId={workspaceId}
									wallKey="webhooks"
								>
									<WebhookSection projectId={projectId} />
								</FeatureGate>
							)}
					</Stack>
				)}
				{ready && projectQuery.data && (
					<>
						{ENABLE_CANVAS && (
							<>
								<Divider />
								<ProjectExperimentalSection
									project={projectQuery.data}
									readOnly={!canEdit}
								/>
							</>
						)}
						<Divider />
						<ProjectMoveWorkspace project={projectQuery.data} />
						<Divider />
						<ProjectDangerZone project={projectQuery.data} />
					</>
				)}
			</Stack>
		</PageContainer>
	);
};
