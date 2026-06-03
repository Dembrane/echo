import { useEffect, useState } from "react";
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
	Card,
	SimpleGrid,
	Text,
	Badge,
	Alert,
} from "@mantine/core";
import { useClipboard, useDisclosure } from "@mantine/hooks";
import { IconRefresh, IconCheck } from "@tabler/icons-react";
import {
	useMutation,
	useMutationState,
	useQueryClient,
} from "@tanstack/react-query";
import { useParams } from "react-router";
import { usePostHog } from "@posthog/react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import { Markdown } from "@/components/common/Markdown";
import { toast } from "@/components/common/Toaster";
import { ConversationDangerZone } from "@/components/conversation/ConversationDangerZone";
import { ConversationEdit } from "@/components/conversation/ConversationEdit";
import { ConversationLink } from "@/components/conversation/ConversationLink";
import { LockedTranscriptOverlay } from "@/components/conversation/LockedTranscriptOverlay";
import {
	useConversationById,
	useConversationChunks,
	useConversationHasTranscript,
	useUpdateConversationByIdMutation,
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
	const queryClient = useQueryClient();
	const posthog = usePostHog();
	const updateConversationMutation = useUpdateConversationByIdMutation();

	const [hasVoted, setHasVoted] = useState(false);
	const [feedbackSaved, setFeedbackSaved] = useState(false);
	const [votedOption, setVotedOption] = useState<string | null>(null);
	const [overrideSummaryContent, setOverrideSummaryContent] = useState<string | null>(null);

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

	const isAnonymized = conversationQuery.data?.is_anonymized ?? false;
	const isLocked = conversationQuery.data?.locked === true;

	const openSourceSummaryMutation = useMutation({
		mutationFn: async () => {
			const response = await generateConversationSummary(conversationId ?? "", "open_source");
			return response;
		},
	});

	const [randomized, setRandomized] = useState<{
		label1: string;
		label2: string;
		content1: string;
		content2: string;
		type1: "control" | "variant";
		type2: "control" | "variant";
	} | null>(null);

	useEffect(() => {
		if (
			openSourceSummaryMutation.data &&
			"summary" in openSourceSummaryMutation.data &&
			conversationQuery.data?.summary
		) {
			const isGeminiFirst = Math.random() > 0.5;
			const geminiSummary = conversationQuery.data.summary;
			const openSourceSummary = openSourceSummaryMutation.data.summary;

			setRandomized({
				label1: isGeminiFirst ? t`Summary Option A (Model 1)` : t`Summary Option A (Model 2)`,
				label2: isGeminiFirst ? t`Summary Option B (Model 2)` : t`Summary Option B (Model 1)`,
				content1: isGeminiFirst ? geminiSummary : openSourceSummary,
				content2: isGeminiFirst ? openSourceSummary : geminiSummary,
				type1: isGeminiFirst ? "control" : "variant",
				type2: isGeminiFirst ? "variant" : "control",
			});
		}
	}, [openSourceSummaryMutation.data, conversationQuery.data?.summary]);

	const handleVote = (option: "A" | "B" | "both" | "neither") => {
		if (
			!randomized ||
			!conversationQuery.data?.summary ||
			!openSourceSummaryMutation.data ||
			!("summary" in openSourceSummaryMutation.data)
		) {
			return;
		}

		const geminiSummary = conversationQuery.data.summary;
		const openSourceSummary = openSourceSummaryMutation.data.summary;

		let preferredType: string = option;
		if (option === "A") {
			preferredType = randomized.type1;
			setOverrideSummaryContent(randomized.content1);
		} else if (option === "B") {
			preferredType = randomized.type2;
			setOverrideSummaryContent(randomized.content2);
		} else {
			setOverrideSummaryContent(null);
		}

		try {
			posthog?.capture("summary_preference_feedback", {
				conversation_id: conversationId,
				project_id: projectId,
				preferred_option: option,
				preferred_type: preferredType,
				control_model: "gemini-2.5-pro",
				variant_model: "open-source",
				summary_control: geminiSummary,
				summary_variant: openSourceSummary,
			});
		} catch (error) {
			console.warn("PostHog tracking failed:", error);
		}

		setHasVoted(true);
		setVotedOption(option);
		toast.success(t`Thank you for your feedback!`);
	};

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
		<Stack gap="3rem" className="relative" pt="2rem" pb="2rem">
			<LoadingOverlay visible={conversationQuery.isLoading} />
			{conversationChunksQuery.data &&
				conversationChunksQuery.data?.length > 0 && (
					<Stack gap="1.5rem">
						<Group>
							<Title order={2}>
								<Trans>Summary</Trans>
							</Title>
							{!isLocked && (
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
											overrideSummaryContent ??
											conversationQuery.data?.summary ??
											(useHandleGenerateSummaryManually.data &&
											"summary" in useHandleGenerateSummaryManually.data
												? useHandleGenerateSummaryManually.data.summary
												: "")
										}
									/>
								</div>

								{conversationQuery.data?.summary && (
									<Card withBorder radius="md" p="md" mt="xl" bg="gray.0">
										<Stack gap="sm">
											<Group justify="space-between">
												<Group gap="xs">
													<Text size="sm" fw={700} c="blue.7">
														<Trans>⚖️ Model Preference A/B Test</Trans>
													</Text>
													<Badge color="blue" size="sm" variant="light">
														<Trans>Experimental</Trans>
													</Badge>
												</Group>
											</Group>

											{!randomized && !openSourceSummaryMutation.isPending && !openSourceSummaryMutation.isError && (
												<Stack gap="xs">
													<Text size="sm" c="gray.7">
														<Trans>Help us choose our next AI model! Compare the current summary with an alternative open-source model (such as DeepSeek or Mistral) in a blind test.</Trans>
													</Text>
													<Button
														size="xs"
														variant="light"
														color="blue"
														style={{ alignSelf: "flex-start" }}
														onClick={() => openSourceSummaryMutation.mutate()}
													>
														<Trans>Compare Summaries</Trans>
													</Button>
												</Stack>
											)}

											{openSourceSummaryMutation.isPending && (
												<Stack align="center" py="md" gap="xs">
													<LoadingOverlay visible={true} overlayProps={{ blur: 1 }} />
													<Text size="sm" c="gray.6">
														<Trans>Generating alternative summary... Please wait.</Trans>
													</Text>
												</Stack>
											)}

											{openSourceSummaryMutation.isError && (
												<Alert color="red" title={t`Error generating alternative summary`}>
													<Text size="xs">
														<Trans>We could not generate the alternative summary. This might be because the open-source model is not configured in this environment.</Trans>
													</Text>
												</Alert>
											)}

											{randomized && (
												<Stack gap="md">
													{!hasVoted ? (
														<>
															<Text size="xs" c="gray.6" italic>
																<Trans>To keep the test unbiased, model names are hidden. Choose the option that provides the better summary.</Trans>
															</Text>

															<SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
																<Card withBorder radius="md" p="sm" bg="white">
																	<Text fw={700} size="sm" mb="xs" c="blue.6">
																		{randomized.label1}
																	</Text>
																	<Markdown content={randomized.content1} />
																</Card>

																<Card withBorder radius="md" p="sm" bg="white">
																	<Text fw={700} size="sm" mb="xs" c="blue.6">
																		{randomized.label2}
																	</Text>
																	<Markdown content={randomized.content2} />
																</Card>
															</SimpleGrid>

															<Stack gap="xs" mt="sm">
																<Text fw={600} size="sm">
																	<Trans>Which summary is better?</Trans>
																</Text>
																<Group gap="xs">
																	<Button
																		size="xs"
																		variant="outline"
																		onClick={() => handleVote("A")}
																	>
																		<Trans>Option A is Better</Trans>
																	</Button>
																	<Button
																		size="xs"
																		variant="outline"
																		onClick={() => handleVote("B")}
																	>
																		<Trans>Option B is Better</Trans>
																	</Button>
																	<Button
																		size="xs"
																		variant="subtle"
																		color="gray"
																		onClick={() => handleVote("both")}
																	>
																		<Trans>Both are Good</Trans>
																	</Button>
																	<Button
																		size="xs"
																		variant="subtle"
																		color="gray"
																		onClick={() => handleVote("neither")}
																	>
																		<Trans>Neither is Good</Trans>
																	</Button>
																</Group>
															</Stack>
														</>
													) : (
														<Stack gap="sm">
															<Alert color="green" icon={<IconCheck size={16} />}>
																<Text size="sm" fw={600}>
																	<Trans>Thank you for your feedback! Your preference has been saved.</Trans>
																</Text>
																<Text size="xs" mt="xs">
																	{votedOption === "A" && t`You selected Option A.`}
																	{votedOption === "B" && t`You selected Option B.`}
																	{votedOption === "both" && t`You selected "Both are good".`}
																	{votedOption === "neither" && t`You selected "Neither is good".`}
																	{" "}
																	{votedOption === "A" && randomized.type1 === "control" && t`Option A was generated by our default model (Gemini).`}
																	{votedOption === "A" && randomized.type1 === "variant" && t`Option A was generated by our alternative open-source model.`}
																	{votedOption === "B" && randomized.type2 === "control" && t`Option B was generated by our default model (Gemini).`}
																	{votedOption === "B" && randomized.type2 === "variant" && t`Option B was generated by our alternative open-source model.`}
																</Text>
															</Alert>

															{((votedOption === "A" && randomized.type1 === "variant") ||
																(votedOption === "B" && randomized.type2 === "variant")) &&
																!feedbackSaved && (
																	<Card withBorder p="sm" bg="blue.0" mt="xs">
																		<Stack gap="xs">
																			<Text size="sm">
																				<Trans>Since you preferred the alternative summary, would you like to keep it as the permanent summary for this conversation?</Trans>
																			</Text>
																			<Button
																				size="xs"
																				color="blue"
																				loading={updateConversationMutation.isPending}
																				onClick={async () => {
																					const newSummary = votedOption === "A" ? randomized.content1 : randomized.content2;
																					await updateConversationMutation.mutateAsync({
																						id: conversationId ?? "",
																						payload: { summary: newSummary }
																					});
																					setFeedbackSaved(true);
																					toast.success(t`Alternative summary saved permanently!`);
																				}}
																				style={{ alignSelf: "flex-start" }}
																			>
																				<Trans>Save Alternative Summary Permanently</Trans>
																			</Button>
																		</Stack>
																	</Card>
																)}

															{feedbackSaved && (
																<Text size="xs" c="green.7" fw={600}>
																	<Trans>✓ Alternative summary has been saved permanently to this conversation!</Trans>
																</Text>
															)}

															<Group gap="xs" mt="xs">
																<Button
																	size="xs"
																	variant="subtle"
																	color="gray"
																	onClick={() => {
																		setHasVoted(false);
																		setVotedOption(null);
																		setOverrideSummaryContent(null);
																	}}
																>
																	<Trans>← Back to Preference Selector</Trans>
																</Button>
															</Group>
														</Stack>
													)}
												</Stack>
											)}
										</Stack>
									</Card>
								)}

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
						<ConversationDangerZone
							conversation={conversationQuery.data}
							disableDownloadAudio={isAnonymized}
							locked={isLocked}
						/>
					</Stack>
				</>
			)}

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
