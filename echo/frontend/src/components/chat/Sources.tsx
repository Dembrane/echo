import { Box, Badge, Group, Text } from "@mantine/core";
import { I18nLink } from "@/components/common/i18nLink";
import { Trans } from "@lingui/react/macro";

export const Sources = ({
  metadata,
  projectId,
}: {
  metadata: any[];
  projectId: string | undefined;
}) => {
  const references = metadata.filter((m) => m.type === "reference");

  if (references.length === 0) return null;

  return (
    <Box className="prose prose-sm flex flex-col rounded-t-xl rounded-br-xl border p-4">
      <Group gap="sm" align="center">
        <Box w={15} h={15} bg="green.5" style={{ borderRadius: "50%" }} />
        <Text size="sm" fw={500} my={2}>
          <Trans>Citing the following sources</Trans>
        </Text>
      </Group>
      <Group gap="xs" mt={10}>
        {references.map((ref, index) => (
          <I18nLink
            key={index}
            to={`/projects/${projectId}/conversation/${ref?.conversation?.id || ref?.conversation}/overview`}
          >
            <Badge className="cursor-pointer normal-case" variant="default">
              {ref?.conversation_title ||
                ref?.conversation?.participant_name || (
                  <Trans>Source {index + 1}</Trans>
                )}
            </Badge>
          </I18nLink>
        ))}
      </Group>
    </Box>
  );
};
