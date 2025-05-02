import { Box, Badge, Group, Text, HoverCard, List } from "@mantine/core";
import { I18nLink } from "@/components/common/i18nLink";
import { Trans } from "@lingui/react/macro";

export const References = ({
  metadata,
  projectId,
}: {
  metadata: any[];
  projectId: string | undefined;
}) => {
  const citations = metadata.filter((m) => m.type === "citation");

  if (citations.length === 0) return null;

  return (
    <Box className="prose prose-sm flex flex-col">
      <Text component="h3" size="lg" my={0}>
        <Trans>References</Trans>
      </Text>

      <ul className="list-disc space-y-1 pl-5 text-gray-700 [&>li::marker]:text-gray-300">
        {citations.map((citation, index) => (
          <li key={index}>
            <Text size="sm" className="leading-relaxed" my={10}>
              <span className="mr-2">
                <Trans>{citation.reference_text}</Trans>
              </span>
              <I18nLink
                to={`/projects/${projectId}/conversation/${citation?.conversation?.id || citation?.conversation}/overview`}
              >
                <Badge
                  size="sm"
                  variant="light"
                  color="gray"
                  className="cursor-pointer transition-colors hover:bg-gray-200"
                >
                  <Text
                    size="xs"
                    className="normal-case leading-relaxed text-gray-700"
                  >
                    {citation?.conversation_title ||
                      citation?.conversation?.participant_name || (
                        <Trans>Untitled Conversation</Trans>
                      )}
                  </Text>
                </Badge>
              </I18nLink>
            </Text>
          </li>
        ))}
      </ul>
    </Box>
  );
};
