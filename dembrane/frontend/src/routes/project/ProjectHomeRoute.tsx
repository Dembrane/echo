import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Grid,
	Group,
	Skeleton,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	BookOpenIcon,
	ChatCircleDotsIcon,
	FileTextIcon,
	PencilSimpleIcon,
	TargetIcon,
	TextAaIcon,
	UploadSimpleIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { InputModal } from "@/components/common/InputModal";
import { I18nLink } from "@/components/common/i18nLink";
import { ConversationsMiniList } from "@/components/conversation/ConversationsMiniList";
import { PageContainer } from "@/components/layout/PageContainer";
import {
	useProjectById,
	useUpdateProjectByIdMutation,
} from "@/components/project/hooks";
import { KEY_TERMS_HASH } from "@/components/project/KeyTermsInput";
import { PortalSettingsOverview } from "@/components/project/PortalSettingsOverview";
import { PROJECT_CONTEXT_HASH } from "@/components/project/ProjectContextInput";
import { ProjectQRCode } from "@/components/project/ProjectQRCode";
import { SampleProjectNotice } from "@/components/project/SampleProjectNotice";
import { useLatestProjectReport } from "@/components/report/hooks";
import { reportStatusLabel } from "@/components/sharing/StatusLine";
import { useWorkspace } from "@/hooks/useWorkspace";
import { canUseChat, isReadOnlyRole } from "@/lib/roles";
import { testId } from "@/lib/testUtils";

export const ProjectHomeRoute = () => {
	const { workspaceId, projectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();
	const { workspace } = useWorkspace();
	const [renameOpened, renameHandlers] = useDisclosure(false);
	const queryClient = useQueryClient();
	const updateProject = useUpdateProjectByIdMutation();
	// Observers lack project:update, so the rename and settings affordances
	// are hidden rather than shown and answered with a 403.
	const canEditProject = !!workspace && !isReadOnlyRole(workspace.role);
	const canChat = !!workspace && canUseChat(workspace.role);

	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: [
				"id",
				"name",
				"language",
				"visibility",
				"is_conversation_allowed",
				"default_conversation_title",
				"anonymize_transcripts",
				"is_get_reply_enabled",
				"is_verify_enabled",
				"default_conversation_ask_for_participant_name",
				"default_conversation_ask_for_participant_email",
				"is_dembrane_event_cta_enabled",
				"is_sample",
			],
		},
	});
	const reportQuery = useLatestProjectReport(projectId ?? "");

	const project = projectQuery.data;
	// A sample project takes no conversations, so sharing and uploads are left out.
	const isSample = project?.is_sample === true;
	const report = reportQuery.data;
	const reportTitle = report?.title?.trim();

	const base = `/w/${workspaceId}/projects/${projectId}`;
	// The portal editor sits in the settings summary, so it isn't repeated here.
	const jumps = [
		canChat && {
			icon: <ChatCircleDotsIcon size={20} />,
			label: <Trans>Start a chat</Trans>,
			to: "chats/new",
		},
		canEditProject &&
			!isSample && {
				icon: <UploadSimpleIcon size={20} />,
				label: <Trans>Upload audio</Trans>,
				to: "upload",
			},
		{
			icon: <BookOpenIcon size={20} />,
			label: <Trans>Host guide</Trans>,
			to: "host-guide",
		},
		{
			icon: <FileTextIcon size={20} />,
			label: <Trans>Report</Trans>,
			to: "report",
		},
		canEditProject && {
			icon: <TextAaIcon size={20} />,
			label: <Trans>Set key terms</Trans>,
			testId: "project-home-set-key-terms",
			to: `portal-editor#${KEY_TERMS_HASH}`,
		},
		canEditProject && {
			icon: <TargetIcon size={20} />,
			label: <Trans>Set project context</Trans>,
			testId: "project-home-set-project-context",
			to: `overview#${PROJECT_CONTEXT_HASH}`,
		},
	].filter(Boolean) as {
		to: string;
		icon: ReactNode;
		label: ReactNode;
		testId?: string;
	}[];

	return (
		<PageContainer width="xl">
			<Stack gap="xl">
				<Stack gap="xs">
					{project?.name ? (
						<Group gap="xs" align="center" wrap="nowrap">
							<Title order={2} lineClamp={1}>
								{project.name}
							</Title>
							{canEditProject && (
								<Tooltip label={t`Rename project`}>
									<ActionIcon
										variant="subtle"
										color="gray"
										aria-label={t`Rename project`}
										onClick={renameHandlers.open}
										{...testId("project-home-rename-button")}
									>
										<PencilSimpleIcon size={20} />
									</ActionIcon>
								</Tooltip>
							)}
						</Group>
					) : (
						<Skeleton height={32} width={240} />
					)}
					<Text size="sm" c="dimmed" maw={560}>
						<Trans>
							Share the project, watch live activity, and jump into the main
							tools from one place.
						</Trans>
					</Text>
				</Stack>

				{isSample && <SampleProjectNotice />}

				<Grid gutter="xl">
					<Grid.Col span={{ base: 12, md: 8 }}>
						<Stack gap="xl">
							{!isSample && (
								<Card p="md">
									<Stack gap="md">
										<Title order={4}>
											<Trans>Take part</Trans>
										</Title>
										<ProjectQRCode project={project} />
									</Stack>
								</Card>
							)}

							{projectId && workspaceId && (
								<ConversationsMiniList
									projectId={projectId}
									workspaceId={workspaceId}
									withTitle
								/>
							)}

							{report && reportTitle && (
								<Stack gap="sm">
									<Title order={5}>
										<Trans>Latest report</Trans>
									</Title>
									<Card component={I18nLink} to={`${base}/report`} p="md">
										<Stack gap="xs">
											<Group gap="xs" align="center">
												<Text size="sm">{reportTitle}</Text>
												<Badge size="xs" variant="light">
													{reportStatusLabel(report.status)}
												</Badge>
											</Group>
											{report.date_created && (
												<Text size="xs" c="dimmed">
													{new Date(report.date_created).toLocaleString()}
												</Text>
											)}
										</Stack>
									</Card>
								</Stack>
							)}
						</Stack>
					</Grid.Col>

					<Grid.Col span={{ base: 12, md: 4 }}>
						<Stack gap="xl">
							<PortalSettingsOverview project={project} base={base} />

							<Stack gap="sm">
								<Title order={5}>
									<Trans>Jump to</Trans>
								</Title>
								<Stack gap="xs">
									{jumps.map((jump) => (
										<Button
											key={jump.to}
											component={I18nLink}
											to={`${base}/${jump.to}`}
											fullWidth
											justify="flex-start"
											leftSection={jump.icon}
											{...(jump.testId ? testId(jump.testId) : {})}
										>
											{jump.label}
										</Button>
									))}
								</Stack>
							</Stack>
						</Stack>
					</Grid.Col>
				</Grid>
			</Stack>
			<InputModal
				opened={renameOpened}
				onClose={renameHandlers.close}
				title={t`Rename project`}
				label={<Trans>Project name</Trans>}
				initialValue={project?.name ?? ""}
				loading={updateProject.isPending}
				onConfirm={(name) => {
					if (!projectId || name === project?.name) {
						renameHandlers.close();
						return;
					}
					updateProject.mutate(
						{ id: projectId, payload: { name } },
						{
							onSuccess: () => {
								// Project lists on the workspace home and sidebar read
								// the name from this cache, not from ["projects", id].
								queryClient.invalidateQueries({
									queryKey: ["v2", "workspace-projects"],
								});
								renameHandlers.close();
							},
						},
					);
				}}
				data-testid="project-rename-modal"
			/>
		</PageContainer>
	);
};
