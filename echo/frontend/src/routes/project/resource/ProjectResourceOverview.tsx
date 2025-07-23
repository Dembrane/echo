import { Trans } from "@lingui/react/macro";
import { useResourceById } from "@/components/resource/hooks";
import {
  useDeleteResourceByIdMutation,
  useUpdateResourceByIdMutation,
} from "@/components/resource/hooks";
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { useParams } from "react-router-dom";
import { IconExternalLink, IconTrash } from "@tabler/icons-react";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { apiCommonConfig } from "@/lib/api";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { UnsavedChanges } from "@/components/form/UnsavedChanges";

const ResourceDangerZone = ({ resource }: { resource: TResource }) => {
  const deleteResourceByIdMutation = useDeleteResourceByIdMutation();
  const navigate = useI18nNavigate();
  const { projectId } = useParams();

  const handleDelete = () => {
    if (window.confirm("Are you sure you want to delete this resource?")) {
      deleteResourceByIdMutation.mutate(resource.id);
      navigate(`/projects/` + projectId + "/overview");
    }
  };

  return (
    <Stack>
      <Title order={2}>Danger Zone</Title>
      <Box>
        <Button
          onClick={handleDelete}
          color="red"
          variant="outline"
          rightSection={<IconTrash />}
        >
          Delete Resource
        </Button>
      </Box>
    </Stack>
  );
};

// type TResource = {
//   id: string;
//   created_at: Date;
//   updated_at: Date;
//   project_id: string;
//   is_processed: boolean;
//   type: string;
//   original_filename: string;
//   title: string;
//   description?: string;
//   context?: string;
//   processing_error?: string;
// };

type ResourceEditFormValues = {
  title: string;
  description: string;
  context: string;
};

const ResourceEdit = ({ resource }: { resource: TResource }) => {
  const updateResourceMutation = useUpdateResourceByIdMutation();

  const defaultValues: ResourceEditFormValues = {
    title: resource.title ?? "",
    description: resource.description ?? "",
    context: resource.context ?? "",
  };

  const {
    register,
    handleSubmit,
    formState: { isSubmitSuccessful, isDirty },
    getValues,
    reset,
  } = useForm<ResourceEditFormValues>({
    defaultValues,
  });

  useEffect(() => {
    if (isSubmitSuccessful) {
      reset(getValues());
    }
  }, [getValues, isSubmitSuccessful, reset]);

  const onSubmit = (data: ResourceEditFormValues) => {
    updateResourceMutation.mutate({
      id: resource.id,
      update: data,
    });
  };

  return (
    <Stack>
      <Group>
        <Title order={2}>
          <Trans>Edit Resource</Trans>
        </Title>
        <UnsavedChanges isDirty={isDirty} />
      </Group>
      <form onSubmit={handleSubmit(onSubmit)}>
        <Stack>
          <TextInput
            label="Title"
            {...register("title")}
            defaultValue={resource.title}
          />
          <Textarea
            label="Description"
            rows={6}
            {...register("description")}
            defaultValue={resource.description}
          />
          <Textarea
            label="Additional Context"
            rows={6}
            {...register("context")}
            defaultValue={resource.context}
          />

          <Group>
            <Button
              type="submit"
              loading={updateResourceMutation.isPending}
              disabled={!isDirty}
            >
              <Trans>Save</Trans>
            </Button>
            <Button
              type="reset"
              variant="outline"
              onClick={() => reset(defaultValues)}
              disabled={!isDirty}
            >
              <Trans>Cancel</Trans>
            </Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
};

export const ProjectResourceOverviewRoute = () => {
  const { resourceId } = useParams();
  const resourceQuery = useResourceById(resourceId ?? "");

  return (
    <Stack className="relative">
      <LoadingOverlay visible={resourceQuery.isLoading} />
      <Box>
        <Text size="md">Original File</Text>
        <Group>
          <Text size="sm">{resourceQuery.data?.original_filename}</Text>
          <Tooltip label="Open in new tab">
            <a
              href={
                apiCommonConfig.baseURL +
                "/resources/" +
                resourceQuery.data?.id +
                "/content"
              }
              target="_blank"
            >
              <ActionIcon color="gray" variant="subtle" size="md">
                <IconExternalLink />
              </ActionIcon>
            </a>
          </Tooltip>
        </Group>
      </Box>
      <Box>
        <Text size="md">Created on</Text>
        <Text size="sm">{resourceQuery.data?.created_at.toLocaleString()}</Text>
      </Box>
      <Divider />
      {resourceQuery.data && (
        <>
          <ResourceEdit resource={resourceQuery.data} />
          <Divider />
          <ResourceDangerZone resource={resourceQuery.data} />
        </>
      )}
    </Stack>
  );
};
