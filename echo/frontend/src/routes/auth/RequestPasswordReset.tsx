import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRequestPasswordResetMutation } from "@/components/auth/hooks";
import { Button, Container, Stack, TextInput, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useForm } from "react-hook-form";

export const RequestPasswordResetRoute = () => {
  useDocumentTitle(t`Request Password Reset | Dembrane`);
  const { register, handleSubmit } = useForm<{ email: string }>();

  const requestPasswordResetMutation = useRequestPasswordResetMutation();

  const onSubmit = handleSubmit(async (data) => {
    requestPasswordResetMutation.mutate(data.email);
  });

  return (
    <Container size="sm" className="!h-full">
      <Stack className="h-full">
        <Stack className="flex-grow">
          <Title order={1}>
            <Trans>Request Password Reset</Trans>
          </Title>

          <form onSubmit={onSubmit}>
            <Stack>
              <TextInput
                size="lg"
                label="Email"
                {...register("email")}
                placeholder="Email"
                required
                type="email"
              />
              <Button
                size="lg"
                type="submit"
                loading={requestPasswordResetMutation.isPending}
              >
                <Trans>Submit</Trans>
              </Button>
            </Stack>
          </form>
        </Stack>
      </Stack>
    </Container>
  );
};
