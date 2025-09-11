import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Icons } from "@/icons";
import { ActionIcon, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import { PropsWithChildren } from "react";
import { I18nLink } from "../common/i18nLink";

export const ProjectListItem = ({
  project,
}: PropsWithChildren<{
  project: Project;
}>) => {
  const link = `/projects/${project.id}/overview`;

  return (
    <I18nLink to={link}>
      <Paper
        component="a"
        p="sm"
        className="relative hover:!border-primary-400"
        withBorder
      >
        <Group justify="space-between">
          <Stack gap="0">
            <Group align="center">
              <Icons.Calendar />
              <Text className="font-semibold" size="lg">
                {project.name}
              </Text>
            </Group>
            <Text size="sm" c="dimmed">
              <Trans>
                {(project?.conversations_count ?? project?.conversations?.length ?? 0)} Conversations • Edited{" "}
                {formatRelative(
                  new Date(project.updated_at ?? new Date()),
                  new Date(),
                )}
              </Trans>
            </Text>
          </Stack>
        </Group>
      </Paper>
    </I18nLink>
  );
};
