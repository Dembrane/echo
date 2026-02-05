import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Group,
	MultiSelect,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useAutoSave } from "@/hooks/useAutoSave";
import { testId } from "@/lib/testUtils";
import { CloseableAlert } from "../common/ClosableAlert";
import { FormLabel } from "../form/FormLabel";
import { SaveStatus } from "../form/SaveStatus";
import {
	useConversationEmails,
	useUpdateConversationByIdMutation,
	useUpdateConversationTagsMutation,
} from "./hooks";

type ConversationEditFormValues = {
	participant_name: string;
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
					size="sm"
					color={clipboard.copied ? "green" : "gray"}
					onClick={() => clipboard.copy(email)}
				>
					{clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
				</ActionIcon>
			</Tooltip>
		</Group>
	);
};

export const ConversationEdit = ({
	conversation,
	projectTags,
}: {
	conversation: Conversation;
	projectTags: ProjectTag[];
}) => {
	const emailsQuery = useConversationEmails(conversation.id);
	const emails = emailsQuery.data?.emails_csv
		? emailsQuery.data.emails_csv.split(",").filter(Boolean)
		: [];
	const [showEmails, setShowEmails] = useState(false);

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
		tagIdList: sanitizedConversationTagIds,
	};

	const { register, formState, reset, setValue, control, watch, getValues } =
		useForm<ConversationEditFormValues>({
			defaultValues,
		});

	const updateConversationMutation = useUpdateConversationByIdMutation();
	const updateConversationTagsMutation = useUpdateConversationTagsMutation();

	const { dispatchAutoSave, isPendingSave, isSaving, isError, lastSavedAt } =
		useAutoSave({
			initialLastSavedAt: conversation.updated_at ?? new Date(),
			onSave: async (data: ConversationEditFormValues) => {
				await updateConversationMutation.mutateAsync({
					id: conversation.id,
					payload: { participant_name: data.participant_name },
				});

				await updateConversationTagsMutation.mutateAsync({
					conversationId: conversation.id,
					projectId: conversation.project_id as string,
					projectTagIdList: data.tagIdList,
				});

				reset(data, { keepDirty: false, keepValues: true });
			},
		});

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
					<Trans>Edit Conversation</Trans>
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
				<Stack gap="1.5rem">
					{isError && (
						<CloseableAlert color="red">
							<Text size="sm">
								<Trans>Something went wrong</Trans>
							</Text>
						</CloseableAlert>
					)}

					<Box>
						<Text size="sm" c="dimmed">
							<Trans>Created on</Trans>
						</Text>
						<Text size="sm">
							{new Date(conversation.created_at ?? new Date()).toLocaleString()}
						</Text>
					</Box>

					{emails.length > 0 && (
						<Box>
							<Group gap="xs" mb="xs">
								<Text size="sm" c="dimmed">
									{emails.length === 1 ? (
										<Trans>Participant Email</Trans>
									) : (
										<Trans>Participant Emails</Trans>
									)}
								</Text>
								<Text
									size="sm"
									c="primary"
									className="cursor-pointer"
									onClick={() => setShowEmails(!showEmails)}
								>
									{showEmails ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
								</Text>
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
							<FormLabel
								label={t`Name`}
								isDirty={formState.dirtyFields.participant_name}
							/>
						}
						{...register("participant_name")}
						{...testId("conversation-edit-name-input")}
					/>

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
									classNames={{
										pill: "!bg-[var(--mantine-primary-color-light)] font-medium",
									}}
									styles={{
										pill: { color: "var(--app-text)" },
									}}
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
										To assign a new tag, please create it first in the project
										overview.
									</Trans>
								</Text>
							</CloseableAlert>
						</Box>
					)}
				</Stack>
			</form>
		</Stack>
	);
};
