import { Trans } from "@lingui/react/macro";
import { Accordion, Group, Skeleton, Stack, Title } from "@mantine/core";
import { BaseSkeleton } from "../common/BaseSkeleton";
import { LoadingSpinner } from "../common/LoadingSpinner";

export const ConversationSkeleton = () => {
  return (
    <Accordion.Item value="conversations">
      <Accordion.Control>
        <Group gap="sm" align="baseline">
          <LoadingSpinner size="xs" />

          <Title order={3}>
            <Trans id="conversation.accordion.skeleton.title">
              Conversations
            </Trans>
          </Title>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <BaseSkeleton count={3} height="80px" width="100%" radius="xs" />
      </Accordion.Panel>
    </Accordion.Item>
  );
};
