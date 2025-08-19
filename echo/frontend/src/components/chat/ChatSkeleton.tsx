import { Trans } from "@lingui/react/macro";
import { Accordion, Group, Skeleton, Stack, Title } from "@mantine/core";
import { BaseSkeleton } from "../common/BaseSkeleton";
import { LoadingSpinner } from "../common/LoadingSpinner";

export const ChatSkeleton = () => {
  return (
    <Accordion.Item value="chat">
      <Accordion.Control>
        <Group gap="sm" align="baseline">
          <LoadingSpinner size="xs" />

          <Title order={3}>
            <Trans id="chat.accordion.skeleton.title">Chats</Trans>
          </Title>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <BaseSkeleton count={3} height="40px" width="100%" radius="xs" />
      </Accordion.Panel>
    </Accordion.Item>
  );
};
