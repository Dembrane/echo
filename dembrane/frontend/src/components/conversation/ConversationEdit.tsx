import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	MultiSelect,
	Stack,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useParams } from "react-router";
import { notifyError } from "@/components/error/notifyError";
import { isFreeTierLimitError } from "@/lib/freeTier";
import {
	AiBudgetWall,
	useAiBudgetWall,
} from "@/components/workspace/AiBudgetWall";
import type { AiAction } from "@/components/workspace/gateWalls";
import { useAutoSave } from "@/hooks/useAutoSave";
import {
	generateConversationSummary,
	generateConversationTitle,
} from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { CloseableAlert } from "../common/ClosableAlert";
import { toast } from "../common/Toaster";
import { FormLabel } from "../form/FormLabel";
import { SaveStatus } from "../form/SaveStatus";
import {
	useConversationEmails,
	useUpdateConversationByIdMutation,
	useUpdateConversationTagsMutation,
} from "./hooks";

type ConversationEditFormValues = {
	title: string;
	participant_name: string;
	summary: string;
	tagIdList: string[];
};

const EmailItem = ({ email }: { email: string }) => {
	const clipboard = useClipboard({ timeout: 1500 });

	return (
		<Group gap="xs">
			<Text size="sm">{email}</Text>
			<Tooltip label={clipboard.copied ? t`Copied` : t`Copy`}>
				<ActionIcon
					variant="subtle"
					color={clipboard.copied ? "green" : "gray"}
					onClick={() => clipboard.copy(email)}
				>
					{clipboard.copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />}
				</ActionIcon>
			</Tooltip>
		</Group>
	);
};

const formatDuration = (seconds: number): string => {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);

	if (h > 0) {
		return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	}
	return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

const getSourceLabel = (source: string | null): string | null => {
	if (!source) return null;
	const lower = source.toLowerCase();
	if (lower.includes("upload")) return "Upload";
	if (lower.includes("portal")) return "Portal";
	if (lower.includes("clone")) return "Clone";
	if (lower.includes("split")) return "Split";
	return null;
};

const getNameDescription = (source: string | null): string => {
	if (!source) return "";
	const lower = source.toLowerCase();
	if (lower.includes("portal"))
		return t`Entered by the participant on the portal`;
	if (lower.includes("upload")) return t`Filename from uploaded file`;
	if (lower.includes("clone")) return t`Copied from original conversation`;
	return "";
};

export const ConversationEdit = ({
	conversation,
	projectTags,
	showSummary = false,
}: {
	conversation: Conversation;
	projectTags: ProjectTag[];
	/** Adds an autosaved Summary field (used by the list-row edit modal). */
	showSummary?: boolean;
}) => {
	const queryClient = useQueryClient();
	const { projectId, workspaceId } = useParams();
	const aiWall = useAiBudgetWall();
	const [aiAction, setAiAction] = useState<AiAction>("summary");
	// True when a used-up AI budget opened its wall for this refusal.
	const openAiWall = (error: unknown, action: AiAction) => {
		setAiAction(action);
		return aiWall.openFor(error);
	};
	const emailsQuery = useConversationEmails(conversation.id);
	const emails = emailsQuery.data?.emails_csv
		? emailsQuery.data.emails_csv.split(",").filter(Boolean)
		: [];
	const [showEmails, setShowEmails] = useState(false);

	const sourceLabel = getSourceLabel(conversation.source);
	const nameDescription = getNameDescription(conversation.source);

	const projectTagOptions = useMemo(
		() =>
			projectTags
				.filter((tag) => tag && tag.id != null && tag.text != null)
				.map((tag) => ({
					label: tag.text ?? "",
					value: tag.id ?? "",
				})),
		[projectTags],
	);

	const conversationTagIds = useMemo(
		() =>
			conversation.tags
				?.filter(
					(tag) => (tag as ConversationProjectTag).project_tag_id != null,
				)
				.map(
					(tag) =>
						((tag as ConversationProjectTag).project_tag_id as ProjectTag).id,
				)
				.filter((id): id is string => id != null) ?? [],
		[conversation.tags],
	);

	const sanitizedConversationTagIds = useMemo(
		() =>
			conversationTagIds.filter((id) =>
				projectTagOptions.some((tag) => tag.value === id),
			),
		[conversationTagIds, projectTagOptions],
	);

	const defaultValues: ConversationEditFormValues = {
		participant_name: conversation.participant_name ?? "",
		summary: conversation.summary ?? "",
		tagIdList: sanitizedConversationTagIds,
		title: conversation.title ?? "",
	};

	const {
		register,
		formState,
		reset,
		setValue,
		control,
		watch,
		getValues,
		getFieldState,
	} = useForm<ConversationEditFormValues>({
		defaultValues,
	});

	// An AI budget refusal opens the wall below instead of a toast.
	const updateConversationMutation = useUpdateConversationByIdMutation({
		onError: (error) => {
			if (isFreeTierLimitError(error) !== "ai_budget") void notifyError(error);
		},
	});
	const updateConversationTagsMutation = useUpdateConversationTagsMutation();

	const { dispatchAutoSave, isPendingSave, isSaving, isError, lastSavedAt } =
		useAutoSave({
			initialLastSavedAt: conversation.updated_at ?? new Date(),
			onSave: async (form: ConversationEditFormValues) => {
				let data = form;
				const update = (withSummary: boolean) =>
					updateConversationMutation.mutateAsync({
						id: conversation.id,
						payload: {
							participant_name: data.participant_name,
							title: data.title || null,
							// Only a summary the host edited here; the form's copy may be older than the saved one.
							...(withSummary ? { summary: data.summary } : {}),
						},
					});
				const summaryEdited = showSummary && getFieldState("summary").isDirty;
				try {
					await update(summaryEdited);
				} catch (error) {
					// Clearing a summary at a used-up AI budget is a regenerate: keep it, save the rest.
					if (!summaryEdited || !openAiWall(error, "summary_again"))
						throw error;
					data = { ...data, summary: conversation.summary ?? "" };
					setValue("summary", data.summary, { shouldDirty: false });
					await update(false);
				}

				await updateConversationTagsMutation.mutateAsync({
					conversationId: conversation.id,
					projectId: conversation.project_id as string,
					projectTagIdList: data.tagIdList,
				});

				reset(data, { keepDirty: false, keepValues: true });
			},
		});

	const generateTitleMutation = useMutation({
		mutationFn: async () => {
			const result = await generateConversationTitle(conversation.id);
			return result;
		},
		mutationKey: ["generateTitle", conversation.id],
		onError: (error) => {
			if (openAiWall(error, getValues("title") ? "title_again" : "title"))
				return;
			void notifyError(error);
		},
		onSuccess: (data) => {
			if (data?.title) {
				setValue("title", data.title, { shouldDirty: false });
			}
			queryClient.invalidateQueries({
				queryKey: ["conversations", conversation.id],
			});
			queryClient.invalidateQueries({
				queryKey: ["projects", conversation.project_id, "conversations"],
			});
		},
	});

	const generateSummaryMutation = useMutation({
		mutationFn: async () => {
			const result = await generateConversationSummary(conversation.id);
			return result;
		},
		mutationKey: ["generateSummary", conversation.id],
		onError: (error) => {
			if (
				openAiWall(
					error,
					getValues("summary")?.trim() ? "summary_again" : "summary",
				)
			)
				return;
			toast.error(t`Could not generate a summary. Please try again.`);
		},
		onSuccess: (data) => {
			// The /summarize endpoint persists the summary (and an optional title)
			// itself, so we only mirror the result into the form and refetch.
			if (
				data &&
				typeof data === "object" &&
				"summary" in data &&
				data.summary
			) {
				setValue("summary", data.summary, { shouldDirty: false });
			} else if (data && typeof data === "object" && "message" in data) {
				toast.info(data.message);
			}
			queryClient.invalidateQueries({
				queryKey: ["conversations", conversation.id],
			});
			queryClient.invalidateQueries({
				queryKey: ["projects", conversation.project_id, "conversations"],
			});
		},
	});

	useEffect(() => {
		const nextTitle = conversation.title ?? "";
		if (!formState.dirtyFields.title && getValues("title") !== nextTitle) {
			setValue("title", nextTitle, { shouldDirty: false });
		}
	}, [conversation.title, formState.dirtyFields.title, getValues, setValue]);

	const hasSummary = !!conversation.summary;
	const hasTitle = !!watch("title");
	// Locked (free-tier / hours-cap) conversations are gated: generating a
	// summary or title would surface transcript-derived content. Block it.
	const isLocked = !!conversation.locked;
	const canGenerateTitle = hasSummary && !isLocked;
	const isGeneratingTitle = generateTitleMutation.isPending;

	useEffect(() => {
		const currentValues = getValues("tagIdList") ?? [];
		const filteredValues = currentValues.filter((id) =>
			projectTagOptions.some((tag) => tag.value === id),
		);

		if (filteredValues.length !== currentValues.length) {
			setValue("tagIdList", filteredValues, {
				shouldDirty: false,
				shouldTouch: false,
			});
		}
	}, [projectTagOptions, getValues, setValue]);

	useEffect(() => {
		const subscription = watch((values, { type }) => {
			if (type === "change" && values) {
				dispatchAutoSave(values as ConversationEditFormValues);
			}
		});

		return () => subscription.unsubscribe();
	}, [watch, dispatchAutoSave]);

	return (
		<Stack key={conversation.id}>
			<Group>
				<Title order={2}>
					<Trans>Edit conversation</Trans>
				</Title>
				<SaveStatus
					formErrors={formState.errors}
					savedAt={lastSavedAt}
					isPendingSave={isPendingSave}
					isSaving={isSaving}
					isError={isError}
				/>
			</Group>

			<form>
				<Stack gap="md">
					{isError && (
						<CloseableAlert color="red">
							<Text size="sm">
								<Trans>Something went wrong</Trans>
							</Text>
						</CloseableAlert>
					)}

					<Box>
						<Text size="sm">
							<Trans>Created on</Trans>
						</Text>
						<Text size="sm">
							{new Date(conversation.created_at ?? new Date()).toLocaleString()}
						</Text>
					</Box>

					{conversation.recording_started_at && (
						<Box>
							<Text size="sm">
								<Trans>Recording started</Trans>
							</Text>
							<Text size="sm">
								{new Date(conversation.recording_started_at).toLocaleString()}
							</Text>
						</Box>
					)}

					{conversation.duration != null && conversation.duration > 0 && (
						<Box>
							<Text size="sm">
								<Trans>Duration</Trans>
							</Text>
							<Text size="sm">{formatDuration(conversation.duration)}</Text>
						</Box>
					)}

					{emails.length > 0 && (
						<Box>
							<Group gap="xs" mb="xs">
								<Text size="sm" c="dimmed">
									{emails.length === 1 ? (
										<Trans>Participant email</Trans>
									) : (
										<Trans>Participant emails</Trans>
									)}
								</Text>
								<Button
									variant="subtle"
									size="compact-xs"
									onClick={() => setShowEmails(!showEmails)}
								>
									{showEmails ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
								</Button>
							</Group>
							{showEmails && (
								<Stack gap="xs">
									{emails.map((email) => (
										<EmailItem key={email} email={email} />
									))}
								</Stack>
							)}
						</Box>
					)}

					<TextInput
						label={
							<Group gap="xs">
								<FormLabel
									label={t`Name`}
									isDirty={formState.dirtyFields.participant_name}
								/>
								{sourceLabel && (
									<Badge size="xs" color="gray">
										{sourceLabel}
									</Badge>
								)}
							</Group>
						}
						description={nameDescription}
						{...register("participant_name")}
						{...testId("conversation-edit-name-input")}
					/>

					<Box>
						<TextInput
							label={
								<Group gap="xs" justify="space-between" className="w-full">
									<FormLabel
										label={t`Title`}
										isDirty={formState.dirtyFields.title}
									/>
									<Tooltip
										label={
											isLocked
												? t`Upgrade to generate a title for this conversation`
												: t`Generate a summary first`
										}
										disabled={canGenerateTitle}
									>
										<Button
											variant="subtle"
											size="compact-xs"
											loading={isGeneratingTitle}
											disabled={!canGenerateTitle}
											onClick={() => generateTitleMutation.mutate()}
											{...testId("conversation-edit-title-generate-button")}
										>
											{hasTitle ? t`Regenerate` : t`Generate`}
										</Button>
									</Tooltip>
								</Group>
							}
							description={t`Topic-based title describing what was discussed`}
							placeholder={t`Auto-generated or enter manually`}
							disabled={isGeneratingTitle}
							{...register("title")}
							{...testId("conversation-edit-title-input")}
						/>
					</Box>

					{projectTags && projectTags.length > 0 ? (
						<Controller
							name="tagIdList"
							control={control}
							render={({ field }) => (
								<MultiSelect
									{...field}
									placeholder={t`Select tags`}
									label={
										<FormLabel
											label={t`Tags`}
											isDirty={!!formState.dirtyFields.tagIdList}
										/>
									}
									data={projectTagOptions}
									onChange={(value) => {
										field.onChange(value);
										setValue("tagIdList", value, { shouldDirty: true });
									}}
									{...testId("conversation-edit-tags-select")}
								/>
							)}
						/>
					) : (
						<Box>
							<CloseableAlert color="primary">
								<Text size="sm">
									<Trans>
										To assign a new tag, please create it first in the portal
										settings.
									</Trans>
								</Text>
							</CloseableAlert>
						</Box>
					)}

					{showSummary && (
						<Textarea
							label={
								<Group gap="xs" justify="space-between" className="w-full">
									<FormLabel
										label={t`Summary`}
										isDirty={!!formState.dirtyFields.summary}
									/>
									<Tooltip
										label={t`Upgrade to generate summaries for this conversation`}
										disabled={!isLocked}
									>
										<Button
											variant="subtle"
											size="compact-xs"
											loading={generateSummaryMutation.isPending}
											disabled={isLocked}
											onClick={() => generateSummaryMutation.mutate()}
											{...testId("conversation-edit-summary-generate-button")}
										>
											{watch("summary")?.trim() ? t`Regenerate` : t`Generate`}
										</Button>
									</Tooltip>
								</Group>
							}
							description={t`Generated from the transcript. You can edit it.`}
							minRows={4}
							autosize
							{...register("summary")}
							{...testId("conversation-edit-summary-input")}
						/>
					)}
				</Stack>
			</form>
			{workspaceId && (
				<AiBudgetWall
					{...aiWall.props}
					action={aiAction}
					workspaceId={workspaceId}
					projectId={projectId}
				/>
			)}
		</Stack>
	);
};
