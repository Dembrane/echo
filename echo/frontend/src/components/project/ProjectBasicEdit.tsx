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
import { useUpdateProjectByIdMutation } from "./hooks";
import { SaveStatus } from "../form/SaveStatus";
import { FormLabel } from "../form/FormLabel";
import { useAutoSave } from "@/hooks/useAutoSave";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Logo } from "../common/Logo";

const FormSchema = z.object({
  name: z.string().min(4, t`Project name must be at least 4 characters long`),
  context: z.string().optional(),
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
          </Stack>
        </form>
      </Stack>
    </Stack>
  );
};

export default ProjectBasicEdit;
