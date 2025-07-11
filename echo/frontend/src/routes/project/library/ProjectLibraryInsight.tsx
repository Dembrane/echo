import { Trans } from "@lingui/react/macro";
import { useInsight } from "@/components/library/hooks";
import {
  ActionIcon,
  Container,
  Divider,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconArrowBack } from "@tabler/icons-react";
import { useParams } from "react-router-dom";
import { Quote } from "../../../components/quote/Quote";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { I18nLink } from "@/components/common/i18nLink";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { useCopyInsight } from "@/hooks/useCopyInsight";
import { CopyIconButton } from "@/components/common/CopyIconButton";

export const ProjectLibraryInsight = () => {
  const { projectId, insightId } = useParams();

  const insightQuery = useInsight(insightId ?? "");
  const { copied, copyInsight } = useCopyInsight();

  if (!insightQuery.isLoading && !insightQuery.data) {
    return (
      <Stack className="px-2 py-6">
        <Group>
          <I18nLink to="..">
            <ActionIcon>
              <IconArrowBack />
            </ActionIcon>
          </I18nLink>
          <Title order={1}>
            <Trans>Insight Library</Trans>
          </Title>
        </Group>
        <Divider />
        <Text>
          <Trans>Insight not found</Trans>
        </Text>
      </Stack>
    );
  }

  const insight = insightQuery.data;
  const quotes = insight?.quotes;

  if (!insight || !quotes) {
    return <LoadingOverlay visible />;
  }

  return (
    <Container>
      <Stack className="px-2 py-6">
        {/* <Group align="baseline">
          <ActionIcon variant="light" onClick={() => navigate(-1)}>
            <IconChevronLeft />
          </ActionIcon>
          <Title order={1}>Insight Library</Title> */}

        {/* </Group> */}
        <Breadcrumbs
          items={[
            {
              label: (
                <Title order={2}>
                  <Trans>Insights</Trans>
                </Title>
              ),
              link: `/projects/${projectId}/library#insights`,
            },
            {
              label: (
                <Group>
                  <Title order={2}>{insight.title}</Title>
                  <CopyIconButton
                    size={24}
                    onCopy={() => copyInsight(insight.id)}
                    copied={copied}
                  />
                </Group>
              ),
            },
          ]}
        />
        <Divider />

        <Text>{insight.summary}</Text>

        <Divider />
        <Title order={2}>
          <Trans>Quotes</Trans>
        </Title>
        <Stack>
          {quotes.map((quote) => (
            <Quote key={(quote as Quote).id} data={quote as Quote} />
          ))}
        </Stack>
      </Stack>
    </Container>
  );
};
