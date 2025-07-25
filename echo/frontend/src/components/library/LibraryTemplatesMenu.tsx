import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Menu, Pill, Stack, Text } from "@mantine/core";
import { IconNotes } from "@tabler/icons-react";

// all this function does is that if someone clicks on a template, it will set the input to the template content
export const LibraryTemplatesMenu = ({
  onTemplateSelect,
}: {
  onTemplateSelect: ({
    query,
    additionalContext,
    key,
  }: {
    query: string;
    additionalContext: string;
    key: string;
  }) => void;
}) => {
  const templates = [
    {
      title: t`Recurring Themes`,
      icon: IconNotes,
      query: t`Provide an overview of the main topics and recurring themes`,
      additionalContext: t`Identify recurring themes, topics, and arguments that appear consistently across conversations. Analyze their frequency, intensity, and consistency. Expected output: 3-7 aspects for small datasets, 5-12 for medium datasets, 8-15 for large datasets. Processing guidance: Focus on distinct patterns that emerge across multiple conversations.`,
    },
  ];

  return (
    <Stack>
      <Group align="flex-start">
        <Text size="sm" fw={500}>
          <Trans>Suggested:</Trans>
        </Text>
        {templates.map((t) => (
          // no translations for now
          <Pill
            component="button"
            key={t.title}
            variant="default"
            bg="transparent"
            className="border"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onTemplateSelect({
                query: t.query,
                additionalContext: t.additionalContext,
                key: t.title,
              });
            }}
          >
            <Text size="sm">{t.title}</Text>
          </Pill>
        ))}
      </Group>
    </Stack>
  );
};
