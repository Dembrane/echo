import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  useInsightsByConversationId,
  useConversationQuotes,
} from "@/components/conversation/hooks";
import {
  Anchor,
  Button,
  Divider,
  Group,
  SimpleGrid,
  Skeleton,
  Spoiler,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useParams } from "react-router-dom";
import { Quote } from "../../../components/quote/Quote";
import { Insight } from "@/components/insight/Insight";
import { useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";

export const ProjectConversationAnalysis = () => {
  const { conversationId, projectId } = useParams();

  const quotesQuery = useConversationQuotes(conversationId ?? "");

  const insightsQuery = useInsightsByConversationId(conversationId ?? "");
  const [showInsights, setShowInsights] = useState(false);

  return (
    <Stack>
      <Group gap="sm">
        {insightsQuery.data && insightsQuery.data.length > 0 && (
          <Text c="gray" size="xl">
            {insightsQuery.data.length > 99 ? "99+" : insightsQuery.data.length}
          </Text>
        )}
        <Title order={2}>
          <Trans>Insights</Trans>
        </Title>
        {insightsQuery.data && insightsQuery.data.length > 0 && (
          <Button
            variant="transparent"
            onClick={() => setShowInsights(!showInsights)}
          >
            <Text>
              {showInsights ? t`Hide all` : t`Show all`}
              <Trans>insights</Trans>
            </Text>
          </Button>
        )}
      </Group>
      {insightsQuery.error && (
        <Text className="text-red-500">
          <Trans>Error loading insights</Trans>
        </Text>
      )}
      {insightsQuery.isLoading && (
        <>
          <Skeleton height={150} />
          <Skeleton height={150} />
          <Skeleton height={150} />
        </>
      )}
      <Spoiler
        maxHeight={250}
        hideLabel={t`Hide all insights`}
        showLabel={null}
        pb="md"
        expanded={showInsights}
        onExpandedChange={(expanded) => setShowInsights(expanded)}
      >
        {insightsQuery.data && insightsQuery.data.length === 0 && (
          <Text>
            <Trans>
              No insights available. Generate insights for this conversation by
              visiting
              <I18nLink to={`/projects/${projectId}/library`}>
                <Anchor> the project library.</Anchor>
              </I18nLink>
            </Trans>
          </Text>
        )}

        <SimpleGrid cols={3} spacing="sm">
          {insightsQuery.data &&
            insightsQuery.data.map((insight) => (
              <Insight key={insight.id} data={insight as Insight} />
            ))}
        </SimpleGrid>
      </Spoiler>

      <Divider />

      <Group gap="sm">
        {quotesQuery.data && quotesQuery.data.length > 0 && (
          <Text c="gray" size="xl">
            {quotesQuery.data.length > 99 ? "99+" : quotesQuery.data.length}
          </Text>
        )}
        <Title order={2}>
          <Trans>Quotes</Trans>
        </Title>
      </Group>
      {quotesQuery.error && (
        <Text className="text-red-500">
          <Trans>Error loading quotes</Trans>
        </Text>
      )}
      {quotesQuery.isLoading && (
        <>
          <Skeleton height={150} />
          <Skeleton height={150} />
          <Skeleton height={150} />
        </>
      )}

      {quotesQuery.data && quotesQuery.data.length === 0 && (
        <Group>
          <Text component="span">
            <Trans>
              No quotes available. Generate quotes for this conversation by
              visiting
            </Trans>
          </Text>
          <I18nLink to={`/projects/${projectId}/library`}>
            <Anchor component="span">
              <Trans>the project library.</Trans>
            </Anchor>
          </I18nLink>
        </Group>
      )}
      <Stack gap="sm">
        {quotesQuery.data &&
          quotesQuery.data.map((quote) => (
            <Quote key={quote.id} data={quote as Quote} />
          ))}
      </Stack>
      {/* </Spoiler> */}
      {/* <Divider /> */}
    </Stack>
  );
};
