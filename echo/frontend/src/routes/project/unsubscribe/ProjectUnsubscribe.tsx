import { useSearchParams } from "react-router-dom";
import {
  useUpdateProjectContacts,
  useCheckUnsubscribeStatus,
} from "@/lib/query";
import { Button, Stack, Title, Text, Loader, Group } from "@mantine/core";
import { useState } from "react";
import { Logo } from "@/components/common/Logo";
import { IconCheck } from "@tabler/icons-react";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";

export const ProjectUnsubscribe = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const project_id = searchParams.get("project_id") ?? "";

  const {
    data: canUnsubscribe,
    isLoading,
    error,
  } = useCheckUnsubscribeStatus(token, project_id);
  const { mutate, isPending } = useUpdateProjectContacts();
  const [success, setSuccess] = useState(false);

  const handleUnsubscribe = () => {
    mutate(
      { token, project_id, unsubscribe: false },
      {
        onSuccess: () => setSuccess(true),
      },
    );
  };

  return (
    <div className="relative flex !h-dvh flex-col overflow-y-auto">
      <Group
        component="header"
        justify="center"
        className="py-2 shadow-sm"
        style={{
          transition: "opacity 500ms ease-in-out",
        }}
      >
        <Logo hideTitle h="64px" />
      </Group>
      <main className="container mx-auto h-full max-w-2xl">
        <Stack
          className="mt-[64px] px-4 py-8"
          px="2rem"
          py="2rem"
          align="center"
        >
          <Title order={2}>
            <Trans> Unsubscribe from Notifications</Trans>
          </Title>

          {isLoading && <Loader size="sm" />}
          {error && <Text c="red">{error.message}</Text>}
          {success && (
            <Text c="green" size="md" className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-white">
                <IconCheck size={16} strokeWidth={3} />
              </span>
              <Trans>You have successfully unsubscribed.</Trans>
            </Text>
          )}

          {!isLoading && !error && !success && canUnsubscribe && (
            <Button onClick={handleUnsubscribe} disabled={isPending}>
              {isPending ? <Loader size="sm" /> : t`Unsubscribe`}
            </Button>
          )}
        </Stack>
      </main>
    </div>
  );
};
