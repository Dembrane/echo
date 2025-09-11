import { t } from "@lingui/core/macro";
import {
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Radio,
  ScrollArea,
  Stack,
  TextInput,
  Divider,
  Badge,
} from "@mantine/core";
import { useDisclosure, useDebouncedValue } from "@mantine/hooks";
import { useForm, Controller } from "react-hook-form";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { IconArrowsExchange, IconSearch } from "@tabler/icons-react";
import { FormLabel } from "@/components/form/FormLabel";
import { useMoveConversationMutation } from "./hooks";
import { useInfiniteProjects } from "@/components/project/hooks";
import { Trans } from "@lingui/react/macro";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useParams } from "react-router";

export const MoveConversationButton = ({
  conversation,
}: {
  conversation: Conversation;
}) => {
  const [opened, { open, close }] = useDisclosure(false);
  const { ref: loadMoreRef, inView } = useInView();
  const [search, setSearch] = useState("");
  const [debouncedSearchValue] = useDebouncedValue(search, 200);

  const { projectId } = useParams();

  const {
    control,
    handleSubmit,
    watch,
    reset,
    formState: { dirtyFields },
  } = useForm({
    defaultValues: {
      targetProjectId: "",
    },
    mode: "onChange",
  });

  const projectsQuery = useInfiniteProjects({
    query: {
      filter: {
        id: {
          _neq: projectId as string,
        },
        ...(debouncedSearchValue && {
          name: {
            _icontains: debouncedSearchValue,
          },
        }),
      },
      sort: "-updated_at",
    },
    options: {
      initialLimit: 10,
    },
  });

  const moveConversationMutation = useMoveConversationMutation();

  const navigate = useI18nNavigate();

  const handleMove = handleSubmit((data) => {
    if (!data.targetProjectId) return;

    moveConversationMutation.mutate(
      {
        conversationId: conversation.id,
        targetProjectId: data.targetProjectId,
      },
      {
        onSuccess: () => {
          close();
          navigate(
            `/projects/${data.targetProjectId}/conversation/${conversation.id}/overview`,
          );
        },
      },
    );
  });

  useEffect(() => {
    if (!opened) {
      reset();
      setSearch("");
    }
  }, [opened, reset]);

  useEffect(() => {
    if (
      inView &&
      projectsQuery.hasNextPage &&
      !projectsQuery.isFetchingNextPage
    ) {
      projectsQuery.fetchNextPage();
    }
  }, [
    inView,
    projectsQuery.hasNextPage,
    projectsQuery.isFetchingNextPage,
    projectsQuery.fetchNextPage,
  ]);

  const allProjects =
    projectsQuery.data?.pages.flatMap((page) => page.projects) ?? [];

  return (
    <>
      <Button
        onClick={open}
        variant="outline"
        color="blue"
        rightSection={<IconArrowsExchange size={16} />}
      >
        <Group>
          <Badge>
            <Trans>Experimental</Trans>
          </Badge>
          <Trans>Move to Another Project</Trans>
        </Group>
      </Button>

      <Modal opened={opened} onClose={close} title={t`Move Conversation`}>
        <form onSubmit={handleMove}>
          <Stack gap="3rem">
            <Stack gap="md">
              <TextInput
                label={<FormLabel label={t`Search`} isDirty={false} />}
                placeholder={t`Search projects...`}
                leftSection={<IconSearch size={16} />}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />

              <Divider />

              <ScrollArea style={{ height: 300 }} scrollbarSize={4}>
                {projectsQuery.data?.pages.flatMap((page) => page.projects)
                  .length === 0 && (
                  <Center style={{ height: 200 }}>
                    <Trans>
                      No projects found {search && `with "${search}"`}
                    </Trans>
                  </Center>
                )}

                {projectsQuery.isLoading ? (
                  <Center style={{ height: 200 }}>
                    <Loader />
                  </Center>
                ) : (
                  <Controller
                    name="targetProjectId"
                    control={control}
                    render={({ field }) => (
                      <Radio.Group {...field}>
                        <Stack gap="sm">
                          {allProjects.map((project, index) => (
                            <div
                              key={project.id}
                              ref={
                                index === allProjects.length - 1
                                  ? loadMoreRef
                                  : undefined
                              }
                            >
                              <Radio value={project.id} label={project.name} />
                            </div>
                          ))}
                          {projectsQuery.isFetchingNextPage && (
                            <Center>
                              <Loader size="sm" />
                            </Center>
                          )}
                        </Stack>
                      </Radio.Group>
                    )}
                  />
                )}
              </ScrollArea>
            </Stack>

            <Group justify="flex-end">
              <Button
                variant="subtle"
                onClick={close}
                disabled={moveConversationMutation.isPending}
                type="button"
              >
                {t`Cancel`}
              </Button>
              <Button
                type="submit"
                loading={moveConversationMutation.isPending}
                disabled={
                  !dirtyFields.targetProjectId ||
                  moveConversationMutation.isPending
                }
              >
                {t`Move`}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
};
