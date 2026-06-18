import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Card,
	Flex,
	Group,
	SimpleGrid,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import {
	ChatCircleDotsIcon,
	FileTextIcon,
	PaintBrushIcon,
	UploadSimpleIcon,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { useInfiniteConversationsByProjectId } from "@/components/conversation/hooks";
import { PageContainer } from "@/components/layout/PageContainer";
import { useProjectById } from "@/components/project/hooks";
import { PortalSettingsOverview } from "@/components/project/PortalSettingsOverview";
import { ProjectQRCode } from "@/components/project/ProjectQRCode";
import { useLatestProjectReport } from "@/components/report/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

const lineClampStyle = {
	display: "-webkit-box",
	overflow: "hidden",
	WebkitBoxOrient: "vertical",
	WebkitLineClamp: 2,
} as const;

const tagText = (tag: ConversationProjectTag) => {
	const projectTag = tag.project_tag_id as ProjectTag | string | null;
	return typeof projectTag === "object" && projectTag ? projectTag.text : null;
};

const conversationTitle = (conversation: Conversation) =>
	conversation.title?.trim() ||
	conversation.participant_name?.trim() ||
	t`Untitled conversation`;

export const ProjectHomeRoute = () => {
	const { workspaceId, projectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();
	const navigate = useI18nNavigate();

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
			],
		},
	});
	const reportQuery = useLatestProjectReport(projectId ?? "");
	const recentConversationsQuery = useInfiniteConversationsByProjectId(
		projectId ?? "",
		false,
		false,
		{ sort: "-created_at" },
		undefined,
		{ initialLimit: 2 },
	);

	const project = projectQuery.data;
	const report = reportQuery.data;
	const reportTitle = report?.title?.trim();
	const recentConversations =
		recentConversationsQuery.data?.pages.flatMap(
			(page) => page.conversations,
		) ?? [];

	const base = `/w/${workspaceId}/projects/${projectId}`;

	return (
		<PageContainer width="xl">
			<Stack gap="xl">
				<Stack gap={4}>
					{project?.name ? (
						<Title order={2} fw={500} style={{ color: "#2d2d2c" }}>
							{project.name}
						</Title>
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

				<Flex
					direction={{ base: "column", md: "row" }}
					align={{ base: "stretch", md: "flex-start" }}
					gap="xl"
				>
					<PortalSettingsOverview project={project} base={base} />

					<ProjectQRCode project={projectQuery.data} />

					<Stack gap="sm" style={{ flex: 1 }}>
						<Text size="xs" c="dimmed" tt="uppercase">
							<Trans>Jump to</Trans>
						</Text>
								<Group gap="sm" wrap="wrap">
									<Button
										size="sm"
										leftSection={<ChatCircleDotsIcon size={16} />}
										onClick={() => navigate(`${base}/chats/new`)}
									>
										<Trans>Start a chat</Trans>
									</Button>
									<Button
										size="sm"
										leftSection={<UploadSimpleIcon size={16} />}
										variant="outline"
										onClick={() => navigate(`${base}/upload`)}
									>
										<Trans>Upload</Trans>
									</Button>
									<Button
										size="sm"
										leftSection={<PaintBrushIcon size={16} />}
										variant="outline"
										onClick={() => navigate(`${base}/portal-editor`)}
									>
										<Trans>Portal editor</Trans>
									</Button>
									<Button
										size="sm"
										leftSection={<FileTextIcon size={16} />}
										variant="outline"
										onClick={() => navigate(`${base}/report`)}
									>
										<Trans>Report</Trans>
									</Button>
								</Group>
							</Stack>
						</Flex>

						<Stack gap="sm">
							<Group justify="space-between" align="center">
								<Text size="xs" c="dimmed" tt="uppercase">
									<Trans>Latest conversations</Trans>
								</Text>
								<Button
									variant="subtle"
									size="xs"
									onClick={() => navigate(`${base}/conversations`)}
								>
									<Trans>Open all</Trans>
								</Button>
							</Group>

							{recentConversationsQuery.isLoading ? (
								<SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
									<Skeleton height={128} radius="sm" />
									<Skeleton height={128} radius="sm" />
								</SimpleGrid>
							) : recentConversations.length > 0 ? (
								<SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
									{recentConversations.slice(0, 2).map((conversation) => {
										const tags =
											(conversation.tags as
												| ConversationProjectTag[]
												| undefined) ?? [];
										return (
											<I18nLink
												key={conversation.id}
												to={`${base}/conversation/${conversation.id}`}
												className="no-underline block h-full"
											>
												<Card
													component="a"
													withBorder
													p="md"
													radius="sm"
													className="h-full hover:!border-primary-400 transition-colors"
												>
													<Stack gap="xs">
														<Stack gap={2} style={{ minWidth: 0 }}>
															<Text size="sm" fw={500} truncate>
																{conversationTitle(conversation)}
															</Text>
															<Text size="xs" c="dimmed">
																{conversation.created_at
																	? new Date(
																			conversation.created_at,
																		).toLocaleDateString()
																	: ""}
															</Text>
														</Stack>

														<Text size="sm" c="dimmed" style={lineClampStyle}>
															{conversation.summary?.trim() || (
																<Trans>No summary yet</Trans>
															)}
														</Text>

														{tags.length > 0 && (
															<Group gap={6} wrap="wrap">
																{tags.slice(0, 4).map((tag) => {
																	const label = tagText(tag);
																	if (!label) return null;
																	return (
																		<Badge
																			key={tag.id}
																			size="xs"
																			variant="light"
																			color="gray"
																			radius="sm"
																		>
																			{label}
																		</Badge>
																	);
																})}
															</Group>
														)}
													</Stack>
												</Card>
											</I18nLink>
										);
									})}
								</SimpleGrid>
							) : null}
						</Stack>

						{report && reportTitle && (
							<Stack gap="sm">
								<Text size="xs" c="dimmed" tt="uppercase">
									<Trans>Latest report</Trans>
								</Text>
								<I18nLink to={`${base}/report`} className="no-underline block">
									<Card
										component="a"
										withBorder
										p="md"
										radius="sm"
										className="hover:!border-primary-400 transition-colors"
									>
										<Stack gap={2}>
											<Group gap="xs" align="center">
												<Text size="sm" fw={500}>
													{reportTitle}
												</Text>
												<Badge size="xs" variant="light">
													{report.status}
												</Badge>
											</Group>
											{report.date_created && (
												<Text size="xs" c="dimmed">
													{new Date(report.date_created).toLocaleString()}
												</Text>
											)}
										</Stack>
									</Card>
								</I18nLink>
							</Stack>
						)}
					</Stack>
			</PageContainer>
		);
	};
