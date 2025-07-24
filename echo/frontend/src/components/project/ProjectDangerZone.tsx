import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useDeleteProjectByIdMutation } from "./hooks";
import { Box, Button, Stack, Title } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

export const ProjectDangerZone = ({ project }: { project: Project }) => {
  const deleteProjectByIdMutation = useDeleteProjectByIdMutation();
  const navigate = useI18nNavigate();

  const handleDelete = () => {
    if (window.confirm(t`Are you sure you want to delete this project?`)) {
      if (
        window.confirm(
          t`By deleting this project, you will delete all the data associated with it. This action cannot be undone. Are you ABSOLUTELY sure you want to delete this project?`,
        )
      ) {
        deleteProjectByIdMutation.mutate(project.id);
        navigate(`/projects`);
      }
    }
  };

  return (
    <Stack gap="1.5rem">
      <Title order={2}>
        <Trans>Danger Zone</Trans>
      </Title>
      <Box>
        <Button
          onClick={handleDelete}
          color="red"
          variant="outline"
          rightSection={<IconTrash />}
        >
          <Trans>Delete Project</Trans>
        </Button>
      </Box>
    </Stack>
  );
};
