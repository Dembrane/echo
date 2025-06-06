import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  Button,
  Group,
  Menu,
  Pill,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconBrandLinkedin,
  IconCalculator,
  IconNotes,
} from "@tabler/icons-react";
import { CloseableAlert } from "@/components/common/ClosableAlert";

// all this function does is that if someone clicks on a template, it will set the input to the template content
// we need input to check if there is something in the chat box already
export const ChatTemplatesMenu = ({
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
      title: t`Summarize`,
      icon: IconNotes,
      content: t`Transform this content into insights that actually matter. Please:

Extract core ideas that challenge standard thinking
Write like someone who understands nuance, not a textbook
Focus on the non-obvious implications
Keep it sharp and substantive
Only highlight truly meaningful patterns
Structure for clarity and impact
Balance depth with accessibility

Note: If the similarities/differences are too superficial, let me know we need more complex material to analyze.`,
    },
    {
      title: t`Compare & Contrast`,
      icon: IconCalculator,
      content: t`Analyze these elements with depth and nuance. Please:

Focus on unexpected connections and contrasts
Go beyond obvious surface-level comparisons
Identify hidden patterns that most analyses miss
Maintain analytical rigor while being engaging
Use examples that illuminate deeper principles
Structure the analysis to build understanding
Draw insights that challenge conventional wisdom

Note: If the similarities/differences are too superficial, let me know we need more complex material to analyze.`,
    },
    {
      title: t`Meeting Notes`,
      icon: IconNotes,
      content: t`Transform this discussion into actionable intelligence. Please:

Capture the strategic implications, not just talking points
Structure it like a thought leader's analysis, not minutes
Highlight decision points that challenge standard thinking
Keep the signal-to-noise ratio high
Focus on insights that drive real change
Organize for clarity and future reference
Balance tactical details with strategic vision

Note: If the discussion lacks substantial decision points or insights, flag it for deeper exploration next time.`,
    },
    //     {
    //       title: t`LinkedIn Post (Experimental)`,
    //       icon: IconBrandLinkedin,
    //       content: t`Transform these transcripts into a LinkedIn post that cuts through the noise. Please:

    // Extract the most compelling insights - skip anything that sounds like standard business advice
    // Write it like a seasoned leader who challenges conventional wisdom, not a motivational poster
    // Find one genuinely unexpected observation that would make even experienced professionals pause
    // Maintain intellectual depth while being refreshingly direct
    // Only use data points that actually challenge assumptions
    // Keep formatting clean and professional (minimal emojis, thoughtful spacing)
    // Strike a tone that suggests both deep expertise and real-world experience

    // Note: If the content doesn't contain any substantive insights, please let me know we need stronger source material. I'm looking to contribute real value to the conversation, not add to the noise.`,
    //     },
  ];

  return (
    <Stack>
      <Group>
        <Text>
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
            <Text>{t.title}</Text>
          </Pill>
        ))}
      </Group>
    </Stack>
  );
};
