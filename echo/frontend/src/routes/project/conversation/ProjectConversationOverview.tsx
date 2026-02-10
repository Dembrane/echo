import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Divider,
	Group,
	LoadingOverlay,
	Stack,
	Title,
	Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { IconRefresh } from "@tabler/icons-react";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { useParams } from "react-router";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import { Markdown } from "@/components/common/Markdown";
import { toast } from "@/components/common/Toaster";
import { ConversationDangerZone } from "@/components/conversation/ConversationDangerZone";
import { ConversationEdit } from "@/components/conversation/ConversationEdit";
import { ConversationLink } from "@/components/conversation/ConversationLink";
import {
	useConversationById,
	useConversationChunks,
	useConversationHasTranscript,
} from "@/components/conversation/hooks";
import { VerifiedArtefactsSection } from "@/components/conversation/VerifiedArtefactsSection";
import { useProjectById } from "@/components/project/hooks";
import { ENABLE_DISPLAY_CONVERSATION_LINKS } from "@/config";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { generateConversationSummary } from "@/lib/api";
import { testId } from "@/lib/testUtils";

export const ProjectConversationOverviewRoute = () => {
	const { conversationId, projectId } = useParams();

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
			deep: {
				tags: {
					_sort: "sort",
				},
			},
			fields: [
				"id",
				"language",
				{
					tags: ["id", "created_at", "text", "sort"],
				},
			],
		},
	});

	// Check if conversation has any transcript text using aggregate
	const chunksWithTranscriptQuery = useConversationHasTranscript(
		conversationId ?? "",
		10000,
		!!conversationId && !conversationQuery.data?.summary,
	);
	const hasTranscript = (chunksWithTranscriptQuery.data ?? 0) > 0;

	const useHandleGenerateSummaryManually = useMutation({
		mutationFn: async (isRegeneration: boolean) => {
			if (isRegeneration) {
				try {
					analytics.trackEvent(events.REGENERATE_SUMMARY);
				} catch (error) {
					console.warn("Analytics tracking failed:", error);
				}
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
							? t`Summary regenerated successfully.`
							: t`Summary generated successfully.`;
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
			conversationQuery.refetch();
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

	return (
		<Stack gap="3rem" className="relative" px="2rem" pt="2rem" pb="2rem">
			<LoadingOverlay visible={conversationQuery.isLoading} />
			{conversationChunksQuery.data &&
				conversationChunksQuery.data?.length > 0 && (
					<Stack gap="1.5rem">
						<Group>
							<Title order={2}>
								<Trans>Summary</Trans>
							</Title>
							<Group gap="sm">
								{conversationQuery.data?.summary && (
									<CopyIconButton
										size={23}
										onCopy={() => {
											clipboard.copy(conversationQuery.data?.summary ?? "");
										}}
										copied={clipboard.copied}
										copyTooltip={t`Copy Summary`}
										{...testId("conversation-overview-copy-summary-button")}
									/>
								)}
								{conversationQuery.data?.summary && (
									<Tooltip label={t`Regenerate Summary`}>
										<ActionIcon
											variant="transparent"
											loading={isMutationPending}
											onClick={() =>
												window.confirm(
													t`Are you sure you want to regenerate the summary? You will lose the current summary.`,
												) && useHandleGenerateSummaryManually.mutate(true)
											}
											{...testId("conversation-overview-regenerate-summary-button")}
										>
											<IconRefresh size={23} color="gray" />
										</ActionIcon>
									</Tooltip>
								)}
							</Group>
						</Group>

						<Markdown
							content={
								conversationQuery.data?.summary ??
								(useHandleGenerateSummaryManually.data &&
								"summary" in useHandleGenerateSummaryManually.data
									? useHandleGenerateSummaryManually.data.summary
									: "")
							}
						/>

						{!conversationQuery.isFetching &&
							!conversationQuery.data?.summary && (
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
										{...testId("conversation-overview-generate-summary-button")}
									>
										{t`Generate Summary`}
									</Button>
									</Tooltip>
								</div>
							)}

			{conversationQuery.data?.summary &&
							conversationQuery.data?.is_finished && <Divider />}
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

			{conversationQuery.data && projectQuery.data && (
				<>
					<Stack gap="1.5rem">
						<ConversationEdit
							key={conversationQuery.data.id}
							conversation={conversationQuery.data}
							projectTags={projectQuery.data.tags as ProjectTag[]}
						/>
					</Stack>

					<Divider />

					{ENABLE_DISPLAY_CONVERSATION_LINKS && (
						<>
							<ConversationLink
								conversation={conversationQuery.data}
								projectId={projectId ?? ""}
							/>
							{conversationQuery?.data?.linked_conversations?.length ||
							conversationQuery?.data?.linking_conversations?.length ? (
								<Divider />
							) : null}
						</>
					)}

					{/* TODO: better design the links component */}
					{/* {conversationQuery?.data?.linked_conversations?.length ||
          conversationQuery?.data?.linking_conversations?.length ? (
            <Stack gap="2.5rem">
              <ConversationLink
                linkingConversations={conversationQuery.data.linking_conversations}
                linkedConversations={conversationQuery.data.linked_conversations}
              />
              <Divider />
            </Stack>
          ) : null} */}

					<Stack gap="1.5rem">
						<ConversationDangerZone conversation={conversationQuery.data} />
					</Stack>
				</>
			)}
		</Stack>
	);
};
