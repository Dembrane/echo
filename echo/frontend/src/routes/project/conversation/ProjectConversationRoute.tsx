import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Button,
	Divider,
	Group,
	LoadingOverlay,
	Stack,
	Text,
	ThemeIcon,
	Title,
	Tooltip,
} from "@mantine/core";
import { useClipboard, useDisclosure } from "@mantine/hooks";
import { DetectiveIcon } from "@phosphor-icons/react";
import {
	IconLock,
	IconRefresh,
	IconRosetteDiscountCheck,
} from "@tabler/icons-react";
import {
	useMutation,
	useMutationState,
	useQueryClient,
} from "@tanstack/react-query";
import posthog from "posthog-js";
import { useParams } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import { Markdown } from "@/components/common/Markdown";
import { toast } from "@/components/common/Toaster";
import { ConversationDangerZone } from "@/components/conversation/ConversationDangerZone";
import { ConversationLink } from "@/components/conversation/ConversationLink";
import { ConversationTranscriptSection } from "@/components/conversation/ConversationTranscriptSection";
import {
	useConversationById,
	useConversationChunks,
	useConversationHasTranscript,
} from "@/components/conversation/hooks";
import { LockedTranscriptOverlay } from "@/components/conversation/LockedTranscriptOverlay";
import { VerifiedArtefactsSection } from "@/components/conversation/VerifiedArtefactsSection";
import { useProjectById } from "@/components/project/hooks";
import { ENABLE_DISPLAY_CONVERSATION_LINKS } from "@/config";
import { generateConversationSummary } from "@/lib/api";
import { testId } from "@/lib/testUtils";

const getTagText = (tag: ConversationProjectTag) => {
	const projectTag = tag.project_tag_id as ProjectTag | string | null;
	return typeof projectTag === "object" && projectTag ? projectTag.text : null;
};

const hasVerifiedArtifacts = (conversation: Conversation) =>
	conversation.conversation_artifacts?.some(
		(artifact) => (artifact as ConversationArtifact).approved_at,
	) ?? false;

export const ProjectConversationRoute = () => {
	const { conversationId, projectId } = useParams();
	const queryClient = useQueryClient();

	const conversationQuery = useConversationById({
		conversationId: conversationId ?? "",
	});
	const conversationChunksQuery = useConversationChunks(
		conversationId ?? "",
		10000,
		["id"],
	);
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: ["id", "language"],
		},
	});

	// Check if conversation has any transcript text using aggregate
	const chunksWithTranscriptQuery = useConversationHasTranscript(
		conversationId ?? "",
		10000,
		!!conversationId && !conversationQuery.data?.summary,
	);
	const hasTranscript = (chunksWithTranscriptQuery.data ?? 0) > 0;

	const conversation = conversationQuery.data;
	const isAnonymized = conversation?.is_anonymized ?? false;
	const isLocked = conversation?.locked === true;
	const isFinished = conversation?.is_finished === true;
	const verified = conversation ? hasVerifiedArtifacts(conversation) : false;
	const primary =
		conversation?.title?.trim() ||
		conversation?.participant_name?.trim() ||
		t`Untitled conversation`;
	const tags =
		(conversation?.tags as ConversationProjectTag[] | undefined) ?? [];

	const useHandleGenerateSummaryManually = useMutation({
		mutationFn: async (isRegeneration: boolean) => {
			if (isRegeneration) {
				posthog.capture("conversation_summary_regenerated");
			}

			const promise = generateConversationSummary(conversationId ?? "");

			toast.promise(promise, {
				error: isRegeneration
					? t`Failed to regenerate the summary. Please try again later.`
					: t`Failed to generate the summary. Please try again later.`,
				loading: isRegeneration
					? t`Regenerating the summary. Please wait...`
					: t`Generating the summary. Please wait...`,
				success: (response) => {
					// Show different message based on whether summary was generated or is being processed
					if (
						response.status === "success" &&
						"summary" in response &&
						response.summary
					) {
						return isRegeneration
							? t`Summary regenerated.`
							: t`Summary generated.`;
					}
					return isRegeneration
						? t`The summary is being regenerated. Please wait for it to be available.`
						: t`The summary is being generated. Please wait for it to be available.`;
				},
			});

			return promise;
		},
		mutationKey: ["generateSummary", conversationId],
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", conversationId],
			});
			queryClient.invalidateQueries({
				queryKey: ["projects", projectId, "conversations"],
			});
		},
	});

	// Check if there's a pending mutation for this conversation across the app
	const pendingMutations = useMutationState({
		filters: {
			mutationKey: ["generateSummary", conversationId],
			status: "pending",
		},
	});
	const isMutationPending = pendingMutations.length > 0;

	const clipboard = useClipboard();
	const [
		regenerateConfirmOpened,
		{ open: openRegenerateConfirm, close: closeRegenerateConfirm },
	] = useDisclosure(false);

	return (
		<Stack gap="2rem" className="relative px-8 py-4">
			<LoadingOverlay visible={conversationQuery.isLoading} />

			{/* Header: name, title, created-at, tags. Duration lives on the list page only. */}
			<Stack gap="xs" {...testId("conversation-detail-header")}>
				<Group gap="sm" align="center" wrap="wrap">
					<Title order={1}>{primary}</Title>
					{verified && (
						<Tooltip label={t`Has verified artifacts`}>
							<ThemeIcon
								variant="subtle"
								color="primary"
								size={22}
								aria-label={t`Verified artifacts`}
							>
								<IconRosetteDiscountCheck size={20} />
							</ThemeIcon>
						</Tooltip>
					)}
					{isAnonymized && (
						<Tooltip label={t`Anonymized conversation`}>
							<ThemeIcon
								variant="subtle"
								color="primary"
								size={22}
								aria-label={t`Anonymized conversation`}
							>
								<DetectiveIcon size={20} />
							</ThemeIcon>
						</Tooltip>
					)}
					{isLocked && (
						<Tooltip
							label={t`Upgrade your workspace to view this conversation`}
						>
							<Badge
								size="sm"
								color="primary"
								variant="light"
								leftSection={<IconLock size={12} />}
							>
								<Trans>Locked</Trans>
							</Badge>
						</Tooltip>
					)}
				</Group>
				{conversation?.title && conversation?.participant_name && (
					<Text size="sm" c="dimmed">
						{conversation.participant_name}
					</Text>
				)}
				<Group gap="sm" wrap="wrap" align="center">
					{conversation?.created_at && (
						<Text size="xs" c="dimmed">
							<Trans>Created on</Trans>:{" "}
							{new Date(conversation.created_at).toLocaleString(undefined, {
								day: "numeric",
								month: "short",
								year: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							})}
						</Text>
					)}
					{tags.length > 0 && (
						<Group gap={6} wrap="wrap">
							{tags.map((tag) => {
								const tagText = getTagText(tag);
								if (!tagText) return null;
								return (
									<Badge
										key={tag.id}
										size="xs"
										variant="light"
										color="gray"
										radius="sm"
										classNames={{ label: "!text-graphite" }}
									>
										{tagText}
									</Badge>
								);
							})}
						</Group>
					)}
				</Group>
			</Stack>

			{/*
			  Single column: summary + verified artifacts, then the transcript
			  directly below the summary, then links + danger zone. The
			  transcript used to sit in a sticky right-hand column; product
			  feedback (2026-06-18) asked for it stacked below the summary.
			*/}
			<Stack gap="3rem">
				<Stack gap="3rem" className="min-w-0">
					{(conversation?.summary ||
						(conversationChunksQuery.data &&
							conversationChunksQuery.data.length > 0)) && (
						<Stack gap="1.5rem">
							<Group>
								<Title order={2}>
									<Trans>Summary</Trans>
								</Title>
								{!isLocked && (
									<Group gap="sm">
										{conversation?.summary && (
											<CopyIconButton
												size={23}
												onCopy={() => {
													clipboard.copy(conversation?.summary ?? "");
												}}
												copied={clipboard.copied}
												copyTooltip={t`Copy Summary`}
												{...testId("conversation-overview-copy-summary-button")}
											/>
										)}
										{conversation?.summary && (
											<Tooltip label={t`Regenerate Summary`}>
												<ActionIcon
													variant="transparent"
													loading={isMutationPending}
													onClick={openRegenerateConfirm}
													{...testId(
														"conversation-overview-regenerate-summary-button",
													)}
												>
													<IconRefresh size={23} color="gray" />
												</ActionIcon>
											</Tooltip>
										)}
									</Group>
								)}
							</Group>

							{isLocked ? (
								<LockedTranscriptOverlay variant="summary" />
							) : (
								<>
									<div {...testId("conversation-overview-summary-content")}>
										<Markdown
											content={
												conversation?.summary ??
												(useHandleGenerateSummaryManually.data &&
												"summary" in useHandleGenerateSummaryManually.data
													? useHandleGenerateSummaryManually.data.summary
													: "")
											}
										/>
									</div>

									{!conversationQuery.isFetching && !conversation?.summary && (
										<div>
											<Tooltip
												color="gray.7"
												position="bottom-start"
												label={
													!hasTranscript
														? t`Summary will be available once the conversation is transcribed`
														: undefined
												}
												disabled={hasTranscript}
											>
												<Button
													variant="outline"
													className="-mt-[2rem]"
													loading={isMutationPending}
													disabled={!hasTranscript}
													onClick={() => {
														useHandleGenerateSummaryManually.mutate(false);
													}}
													{...testId(
														"conversation-overview-generate-summary-button",
													)}
												>
													{t`Generate Summary`}
												</Button>
											</Tooltip>
										</div>
									)}
								</>
							)}

							{conversation?.summary && conversation?.is_finished && (
								<Divider />
							)}
						</Stack>
					)}

					{/* Verified artefacts */}
					{conversationId && projectId && (
						<VerifiedArtefactsSection
							conversationId={conversationId}
							projectId={projectId}
							projectLanguage={projectQuery.data?.language}
						/>
					)}
				</Stack>

				<div className="min-w-0">
					{conversationId && (
						<ConversationTranscriptSection
							conversationId={conversationId}
							isAnonymized={isAnonymized}
							isFinished={isFinished}
							isLocked={isLocked}
							participantName={conversation?.participant_name ?? ""}
						/>
					)}
				</div>

				<Stack gap="3rem" className="min-w-0">
					{conversation && (
						<>
							{ENABLE_DISPLAY_CONVERSATION_LINKS && (
								<>
									<ConversationLink
										conversation={conversation}
										projectId={projectId ?? ""}
									/>
									{conversation?.linked_conversations?.length ||
									conversation?.linking_conversations?.length ? (
										<Divider />
									) : null}
								</>
							)}

							<Stack gap="1.5rem">
								<ConversationDangerZone
									conversation={conversation}
									disableDownloadAudio={isAnonymized}
									locked={isLocked}
								/>
							</Stack>
						</>
					)}
				</Stack>
			</Stack>

			<ConfirmModal
				opened={regenerateConfirmOpened}
				onClose={closeRegenerateConfirm}
				title={t`Regenerate summary`}
				data-testid="conversation-regenerate-summary-modal"
				message={t`Are you sure you want to regenerate the summary? You will lose the current summary.`}
				confirmLabel={<Trans>Regenerate</Trans>}
				onConfirm={() => {
					useHandleGenerateSummaryManually.mutate(true);
					closeRegenerateConfirm();
				}}
			/>
		</Stack>
	);
};
