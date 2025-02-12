import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";
import {
  Box,
  Group,
  MultiSelect,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Controller, useForm } from "react-hook-form";
import {
  useUpdateConversationByIdMutation,
  useUpdateConversationTagsMutation,
} from "@/lib/query";
import { CloseableAlert } from "../common/ClosableAlert";
import { useAutoSave } from "@/hooks/useAutoSave";
import { FormLabel } from "../form/FormLabel";
import { SaveStatus } from "../form/SaveStatus";

type ConversationEditFormValues = {
  participant_name: string;
  tagIdList: string[];
};

export const ConversationEdit = ({
  conversation,
  // @ts-ignore
  projectTags,
}: {
  conversation: Conversation;
  projectTags: ProjectTag[];
}) => {
  const defaultValues: ConversationEditFormValues = {
    participant_name: conversation.participant_name ?? "",
    tagIdList:
      conversation.tags
        ?.filter((tag) => tag.project_tag_id != null)
        .map((tag) => tag.project_tag_id.id) ?? [],
  };

  const {
    register,
    handleSubmit,
    formState,
    reset,
    getValues,
    setValue,
    control,
    watch,
  } = useForm<ConversationEditFormValues>({
    defaultValues,
  });

  const updateConversationMutation = useUpdateConversationByIdMutation();
  const updateConversationTagsMutation = useUpdateConversationTagsMutation();

  const { dispatchAutoSave, isPendingSave, isSaving, isError, lastSavedAt } =
    useAutoSave({
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
      initialLastSavedAt: conversation.updated_at ?? new Date(),
    });

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
          />
          {/* 
          {projectTags && projectTags.length > 0 ? (
            <Controller
              name="tagIdList"
              control={control}
              render={({ field }) => (
                <MultiSelect
                  {...field}
                  label={
                    <FormLabel
                      label={t`Tags`}
                      isDirty={
                        formState.dirtyFields.tagIdList &&
                        formState.dirtyFields.tagIdList.length > 0
                      }
                    />
                  }
                  data={projectTags
                    .filter((tag) => tag && tag.id != null && tag.text != null)
                    .map((tag) => ({
                      value: tag.id ?? "",
                      label: tag.text ?? "",
                    }))}
                  onChange={(value) => {
                    field.onChange(value);
                    setValue("tagIdList", value, { shouldDirty: true });
                  }}
                />
              )}
            />
          ) : (
            <>
              <CloseableAlert color="blue">
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
          )} */}
        </Stack>
      </form>
    </Stack>
  );
};
