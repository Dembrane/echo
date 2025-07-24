import { Trans } from "@lingui/react/macro";
import { Stack, Paper, SimpleGrid, Text, Group, Pill } from "@mantine/core";

export const DummyViews = () => {
  return (
    <Stack>
      <Text c="gray">
        <Trans>
          These default view templates will be created when you generate your
          first library.
        </Trans>
      </Text>
      <Paper p="md">
        <SimpleGrid cols={3}>
          <Paper bg="white" p="md">
            <Text className="font-xl pb-2 font-semibold">
              <Trans>Recurring Themes</Trans>
            </Text>
            <Group>
              <Pill>
                <Trans>0 Aspects</Trans>
              </Pill>
            </Group>
          </Paper>
        </SimpleGrid>
      </Paper>
    </Stack>
  );
};
