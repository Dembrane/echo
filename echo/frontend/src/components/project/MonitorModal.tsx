import { Trans } from "@lingui/react/macro";
import { Modal, Stack, Text, Title, Paper, ThemeIcon } from "@mantine/core";
import { IconActivity } from "@tabler/icons-react";

interface MonitorModalProps {
  opened: boolean;
  onClose: () => void;
}

export const MonitorModal: React.FC<MonitorModalProps> = ({
  opened,
  onClose,
}) => {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Title order={3}>
          <Trans>Monitor</Trans>
        </Title>
      }
      centered
      size="md"
    >
      <Paper p="xl" radius="md" withBorder>
        <Stack gap="lg" align="center">
          <ThemeIcon size={60} radius="xl" variant="light" color="blue">
            <IconActivity size={30} />
          </ThemeIcon>
          
          <Stack gap="md" align="center">
            <Title order={4} ta="center">
              <Trans>Coming Soon!</Trans>
            </Title>
            
            <Text size="md" ta="center" c="dimmed">
              <Trans>
                For now we have targeted the Portal to help monitor their health.
                Soon you will be able to get an overview of all your participants
                at a glance.
              </Trans>
            </Text>
          </Stack>
        </Stack>
      </Paper>
    </Modal>
  );
};