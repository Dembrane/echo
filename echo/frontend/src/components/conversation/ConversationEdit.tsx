import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Group,
	MultiSelect,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { useAutoSave } from "@/hooks/useAutoSave";
import { testId } from "@/lib/testUtils";
import { CloseableAlert } from "../common/ClosableAlert";
import { FormLabel } from "../form/FormLabel";
import { SaveStatus } from "../form/SaveStatus";
import {
	useUpdateConversationByIdMutation,
	useUpdateConversationTagsMutation,
} from "./hooks";

type ConversationEditFormValues = {
	participant_name: string;
	tagIdList: string[];
};

export const ConversationEdit = ({
	conversation,
	projectTags,
}: {
	conversation: Conversation;
	projectTags: ProjectTag[];
}) => {
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
				<Stack gap="2rem">
					{isError && (
						<CloseableAlert color="red">
							<Text size="sm">
								<Trans>Something went wrong</Trans>
							</Text>
						</CloseableAlert>
					)}

					<Box>
						<Text size="md">
							<Trans>Created on</Trans>
						</Text>
						<Text size="sm">
							{new Date(conversation.created_at ?? new Date()).toLocaleString()}
						</Text>
					</Box>

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
						<>
							<CloseableAlert color="primary">
								<Text size="sm">
									<Trans>
										To assign a new tag, please create it first in the project
										overview.
									</Trans>
								</Text>
							</CloseableAlert>
							<Text>
								<Trans>No tags found</Trans>
							</Text>
						</>
					)}
				</Stack>
			</form>
		</Stack>
	);
};
