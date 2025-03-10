import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import React, { useEffect } from "react";
import {
  Group,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Switch,
  Divider,
  Badge,
} from "@mantine/core";
import { useForm, Controller } from "react-hook-form";
import { useUpdateProjectByIdMutation } from "@/lib/query";
import { SaveStatus } from "../form/SaveStatus";
import { FormLabel } from "../form/FormLabel";
import { useAutoSave } from "@/hooks/useAutoSave";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Logo } from "../common/Logo";

const FormSchema = z.object({
  name: z.string().min(4, t`Project name must be at least 4 characters long`),
  context: z.string().optional(),
  is_get_reply_enabled: z.boolean(),
  get_reply_prompt: z.string(),
});

type TFormSchema = z.infer<typeof FormSchema>;

type ProjectBasicEditProps = {
  project: Project;
};

export const ProjectBasicEdit: React.FC<ProjectBasicEditProps> = ({
  project,
}) => {
  const { control, handleSubmit, watch, trigger, formState, getValues, reset } =
    useForm<TFormSchema>({
      defaultValues: {
        name: project.name ?? "",
        context: project.context ?? "",
        is_get_reply_enabled: project.is_get_reply_enabled ?? false,
        get_reply_prompt: project.get_reply_prompt ?? "",
      },
      resolver: zodResolver(FormSchema),
      mode: "onChange",
      reValidateMode: "onChange",
    });

  const updateProjectMutation = useUpdateProjectByIdMutation();

  const onSave = async (values: TFormSchema) => {
    await updateProjectMutation.mutateAsync({
      id: project.id,
      payload: values,
    });
    reset(values, { keepDirty: false, keepValues: true });
  };

  const {
    dispatchAutoSave,
    triggerManualSave,
    isPendingSave,
    isSaving,
    isError,
    lastSavedAt,
  } = useAutoSave({
    onSave,
    initialLastSavedAt: project.updated_at ?? new Date(),
  });

  useEffect(() => {
    const subscription = watch((values, { type }) => {
      if (type === "change" && values) {
        trigger().then((isValid) => {
          if (isValid) {
            dispatchAutoSave(values as TFormSchema);
          }
        });
      }
    });

    return () => subscription.unsubscribe();
  }, [watch, dispatchAutoSave, trigger]);

  return (
    <Stack gap="3rem">
      <Stack gap="1.5rem">
        <Group>
          <Title order={2}>
            <Trans>Edit Project</Trans>
          </Title>
          <SaveStatus
            savedAt={lastSavedAt}
            formErrors={formState.errors}
            isPendingSave={isPendingSave}
            isSaving={isSaving}
            isError={isError}
          />
        </Group>

        <form
          onSubmit={handleSubmit(async (values) => {
            await triggerManualSave(values);
          })}
        >
          <Stack gap="2rem">
            <Controller
              name="name"
              control={control}
              render={({ field }) => (
                <TextInput
                  error={formState.errors.name?.message}
                  label={
                    <FormLabel
                      label={t`Name`}
                      isDirty={formState.dirtyFields.name}
                      error={formState.errors.name?.message}
                    />
                  }
                  {...field}
                />
              )}
            />

            <Controller
              name="context"
              control={control}
              render={({ field }) => (
                <Textarea
                  error={formState.errors.context?.message}
                  label={
                    <FormLabel
                      label={t`Context`}
                      isDirty={formState.dirtyFields.context}
                      error={formState.errors.context?.message}
                    />
                  }
                  rows={4}
                  placeholder={t`How would you describe to a colleague what are you trying to accomplish with this project?
* What is the north star goal or key metric
* What does success look like`}
                  {...field}
                />
              )}
            />

            <Divider />

            <Stack gap="md">
              <Group>
                <Title order={4}>
                  <Trans>Dembrane Reply</Trans>
                </Title>
                <Logo hideTitle />
                <Badge>
                  <Trans>Experimental</Trans>
                </Badge>
              </Group>

              <Text size="sm" c="dimmed">
                <Trans>
                  Enable this feature to allow participants to request
                  AI-powered responses during their conversation. Participants
                  can click "Get Reply" after recording their thoughts to
                  receive contextual feedback, encouraging deeper reflection and
                  engagement. A cooldown period applies between requests.
                </Trans>
              </Text>

              <Controller
                name="is_get_reply_enabled"
                control={control}
                render={({ field }) => (
                  <Switch
                    label={
                      <FormLabel
                        label={t`Enable Dembrane Reply`}
                        isDirty={formState.dirtyFields.is_get_reply_enabled}
                        error={formState.errors.is_get_reply_enabled?.message}
                      />
                    }
                    checked={field.value}
                    onChange={(e) => field.onChange(e.currentTarget.checked)}
                  />
                )}
              />

              <Controller
                name="get_reply_prompt"
                control={control}
                render={({ field }) => (
                  <Textarea
                    label={
                      <FormLabel
                        label={t`Reply Prompt`}
                        isDirty={formState.dirtyFields.get_reply_prompt}
                        error={formState.errors.get_reply_prompt?.message}
                      />
                    }
                    description={
                      <Trans>
                        This prompt guides how the AI responds to participants.
                        Customize it to shape the type of feedback or engagement
                        you want to encourage.
                      </Trans>
                    }
                    minRows={5}
                    {...field}
                  />
                )}
              />
            </Stack>
          </Stack>
        </form>
      </Stack>
    </Stack>
  );
};

export default ProjectBasicEdit;
