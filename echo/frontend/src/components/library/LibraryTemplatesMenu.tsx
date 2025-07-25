import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Menu, Pill, Stack, Text } from "@mantine/core";
import { IconNotes } from "@tabler/icons-react";

// all this function does is that if someone clicks on a template, it will set the input to the template content
export const LibraryTemplatesMenu = ({
  onTemplateSelect,
}: {
  onTemplateSelect: ({
    content,
    key,
  }: {
    content: string;
    key: string;
  }) => void;
}) => {
  const templates = [
    {
      title: t`Recurring Themes`,
      icon: IconNotes,
      content: t`Identify and analyze the recurring themes in this content. Please:

Extract patterns that appear consistently across multiple sources
Look for underlying principles that connect different ideas
Identify themes that challenge conventional thinking
Structure the analysis to show how themes evolve or repeat
Focus on insights that reveal deeper organizational or conceptual patterns
Maintain analytical depth while being accessible
Highlight themes that could inform future decision-making

Note: If the content lacks sufficient thematic consistency, let me know we need more diverse material to identify meaningful patterns.`,
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
            onClick={() =>
              onTemplateSelect({ content: t.content, key: t.title })
            }
          >
            <Text size="sm">{t.title}</Text>
          </Pill>
        ))}
      </Group>
    </Stack>
  );
};
