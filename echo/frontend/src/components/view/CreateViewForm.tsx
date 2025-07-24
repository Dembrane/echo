import { useEffect } from "react";
import { useForm } from "react-hook-form";
import {
  ActionIcon,
  Alert,
  Button,
  Text,
  CloseButton,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Textarea,
  TextInput,
} from "@mantine/core";

import { useLanguage } from "@/hooks/useLanguage";
import { useGenerateProjectViewMutation } from "./hooks";
import { CloseableAlert } from "../common/ClosableAlert";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";

import { IconCircleCheck } from "@tabler/icons-react";
import { Icons } from "@/icons";

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

type CreateViewForm = {
  query: string;
  additionalContext: string;
  language: string;
};

export const CreateView = ({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) => {
  const createViewMutation = useGenerateProjectViewMutation();

  const { iso639_1 } = useLanguage();

  const { register, handleSubmit, reset } = useForm<CreateViewForm>({
    defaultValues: {
      language: iso639_1,
    },
  });

  const onSubmit = (data: CreateViewForm) => {
    createViewMutation.mutate({
      projectId,
      query: data.query,
      additionalContext: data.additionalContext,
      language: data.language || iso639_1,
    });
  };

  useEffect(() => {
    if (createViewMutation.isSuccess) {
      reset();
    }
  }, [createViewMutation.isSuccess, reset]);

  return (
    <Paper
      className="max-w-[800px] border-none"
    >
      <Stack>
        <form>
          <Stack gap="sm">
            {createViewMutation.isError && (
              <Alert variant="filled" color="red">
                {createViewMutation.error?.message}
              </Alert>
            )}
            {createViewMutation.isSuccess && (
              <CloseableAlert variant="light" color="green" icon={<IconCircleCheck />}>
                <Text>
                  <Trans>
                    Your view has been created. Please wait as we process and
                    analyse the data.
                  </Trans>
                </Text>
              </CloseableAlert>
            )}
            <TextInput
              {...register("query")}
              label={t`Enter your query`}
              required
              placeholder={t`Topics`}
            />
            <Textarea
              rows={5}
              {...register("additionalContext")}
              label={t`Add additional context (Optional)`}
              placeholder={t`Give me a list of 5-10 topics that are being discussed.`}
            />
            <NativeSelect
              {...register("language")}
              label={t`Analysis Language`}
              data={languageOptionsByIso639_1}
            />
            <Group className="w-full" justify="flex-end">
              <Button
                onClick={handleSubmit(onSubmit)}
                loading={createViewMutation.isPending}
                disabled={createViewMutation.isPending}
              >
                <Trans>Create View</Trans>
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Paper>
  );
};
