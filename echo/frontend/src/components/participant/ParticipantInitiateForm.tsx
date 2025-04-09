import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  Alert,
  Box,
  Button,
  MultiSelect,
  Stack,
  TextInput,
} from "@mantine/core";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useInitiateConversationMutation } from "@/lib/query";
import { AxiosError } from "axios";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

const FormSchema = z.object({
  name: z.string().optional(),
  tagIdList: z.array(z.string()).default([]),
});

type FormValues = z.infer<typeof FormSchema>;

export const ParticipantInitiateForm = ({ project }: { project: Project }) => {
  const navigate = useI18nNavigate();

  const {
    register,
    setValue,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
  });

  const { isSuccess, isError, ...initiateConversationMutation } =
    useInitiateConversationMutation();

  const onSubmit = (data: FormValues) => {
    initiateConversationMutation.mutate({
      projectId: project.id,
      name: data.name ?? t`Participant`,
      pin: project.pin ?? "",
      tagIdList: data.tagIdList,
      source: "PORTAL_AUDIO",
    });
  };

  useEffect(() => {
    if (isSuccess) {
      if (initiateConversationMutation.data?.id) {
        navigate(
          `/${project.id}/conversation/${initiateConversationMutation.data?.id}`,
        );
      } else {
        reset();
      }
    }
  }, [isSuccess, reset, initiateConversationMutation.data?.id, navigate]);

  useEffect(() => {
    if (isError) {
      reset();
    }
  }, []);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full">
      <Stack className="relative">
        {initiateConversationMutation.error && (
          <Box>
            <Alert color="red" variant="light">
              {(initiateConversationMutation.error instanceof AxiosError &&
                initiateConversationMutation.error.response?.data.detail) ??
                t`Something went wrong`}
            </Alert>
          </Box>
        )}

        {project.default_conversation_ask_for_participant_name && (
          <TextInput
            // this bug! haha. autoFocus was serioursly messing up the animations with the onboarding cards!
            // autoFocus
            required
            size="md"
            label={
              project.conversation_ask_for_participant_name_label ??
              t`Session Name`
            }
            placeholder="Group 1, John Doe, etc."
            {...register("name")}
            error={errors.name?.message}
            className="w-full"
          />
        )}
        {project.tags.length > 0 && (
          <MultiSelect
            label={t`Tags`}
            description={t`Add all that apply`}
            size="md"
            comboboxProps={{
              position: "top",
              middlewares: { flip: false, shift: false },
              offset: 0,
              withinPortal: false,
            }}
            data={project.tags
              .filter((tag) => tag && tag.text != null && tag.id != null)
              .map((tag) => ({
                value: tag.id,
                label: tag.text,
              }))}
            onChange={(value) => {
              setValue("tagIdList", value);
            }}
            className="w-full"
          />
        )}
        <Button
          type="submit"
          size="lg"
          loading={initiateConversationMutation.isPending}
          fullWidth
        >
          <Trans>Begin!</Trans>
        </Button>
      </Stack>
    </form>
  );
};
