import { Trans } from "@lingui/react/macro";
import { Box, Group, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";

type CitationsProps = {
  sources: string[];
};

const Citations = ({ sources }: CitationsProps) => {
  const maxToShow = 3;
  const visibleSources = sources.slice(0, maxToShow);
  const remainingCount = sources.length - visibleSources.length;

  return (
    <>
      <Box className="rounded-bl-0 w-fit rounded-br-[0.75rem] rounded-tl-[0.75rem] rounded-tr-[0.75rem] border border-green-500 px-4 py-3">
        <Group>
          <Box className="rounded-full bg-green-500 p-1">
            <IconCheck size={16} color="white" />
          </Box>
          <Text size="sm">
            <Trans>Searched through the most relevant sources</Trans>
          </Text>
        </Group>
      </Box>

      <Box className="mt-2">
        <Text size="sm" fw={500}>
          <Trans>Citing the following sources</Trans>
        </Text>

        <Group gap="xs" mt="sm">
          {visibleSources.map((source, idx) => (
            <Box key={idx} className="mr-2 rounded bg-gray-100 p-2">
              <Text size="xs">{source}</Text>
            </Box>
          ))}
          {remainingCount > 0 && (
            <Box className="rounded bg-gray-100 p-2">
              <Text size="xs">+{remainingCount} more</Text>
            </Box>
          )}
        </Group>
      </Box>
    </>
  );
};

export default Citations;
