import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ProjectCard } from "@/components/project/ProjectCard";
import { ProjectListItem } from "@/components/project/ProjectListItem";
import { Icons } from "@/icons";
import { getDirectusErrorString } from "@/lib/directus";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  useCreateProjectMutation,
  useCurrentUser,
  useInfiniteProjects,
  useUpdateProjectByIdMutation,
} from "@/lib/query";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Container,
  Divider,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  useDebouncedValue,
  useDocumentTitle,
  useSessionStorage,
} from "@mantine/hooks";
import {
  IconInfoCircle,
  IconLayoutGrid,
  IconLayoutList,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useState, useEffect } from "react";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { CloseableAlert } from "@/components/common/ClosableAlert";
import { useInView } from "react-intersection-observer";
import { useSearchParams } from "react-router-dom";

export const ProjectsHomeRoute = () => {
  useDocumentTitle(t`Projects | Dembrane`);

  const [gridParent] = useAutoAnimate();
  const [listParent] = useAutoAnimate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSearch = searchParams.get("search") || "";
  const [search, setSearch] = useState(initialSearch);

  const [debouncedSearchValue] = useDebouncedValue(search, 200);

  const { ref: loadMoreRef, inView } = useInView();

  const {
    data: projectsData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
    isError,
    error,
  } = useInfiniteProjects({
    query: {
      fields: ["count(conversations)", "*"],
      sort: "-updated_at",
      search: debouncedSearchValue,
    },
  });

  useEffect(() => {
    if (search) {
      setSearchParams({ search });
    } else {
      setSearchParams({});
    }
  }, [search, setSearchParams]);

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const [view, setView] = useSessionStorage<"grid" | "list">({
    key: "projects-home-view",
    defaultValue: "list",
  });

  const navigate = useI18nNavigate();
  const createProjectMutation = useCreateProjectMutation();
  const updateProjectMutation = useUpdateProjectByIdMutation();
  const user = useCurrentUser();

  const { language } = useLanguage();

  const handleCreateProject = async () => {
    const project = await createProjectMutation.mutateAsync({
      name: t`New Project`,
      language:
        language === "en-US" ? "en" : language === "nl-NL" ? "nl" : "en",
    });

    await updateProjectMutation.mutateAsync({
      id: project.id,
      payload: {
        default_conversation_ask_for_participant_name: true,
        default_conversation_tutorial_slug: "none",
        image_generation_model: "MODEST",
        default_conversation_transcript_prompt: "Dembrane",
      },
    });
    navigate(`/projects/${project.id}/overview`);
  };

  const allProjects =
    projectsData?.pages.flatMap((page) => page.projects) ?? [];

  return (
    <Container>
      <Stack>
        <Group justify="space-between">
          <Group align="center">
            <Breadcrumbs
              items={[
                {
                  label: (
                    <Group>
                      <Icons.Home />
                      <Title order={1}>
                        <Trans>Home</Trans>
                      </Title>
                    </Group>
                  ),
                },
              ]}
            />
          </Group>
          {!user.data?.disable_create_project && (
            <Button
              size="md"
              rightSection={<Icons.Plus stroke="white" fill="white" />}
              loading={createProjectMutation.isPending}
              onClick={handleCreateProject}
            >
              <Trans>Create</Trans>
            </Button>
          )}
        </Group>
        <Divider />
        <Group justify="space-between" className="relative">
          <Title order={2}>
            <Trans>Projects</Trans>
          </Title>

          <Group gap="xs">
            <ActionIcon
              disabled={allProjects.length === 0 && debouncedSearchValue === ""}
              variant="transparent"
              onClick={() => setView("list")}
              title="List view"
              color={view === "list" ? "blue" : "gray"}
            >
              <IconLayoutList />
            </ActionIcon>

            <Divider orientation="vertical" />
            <ActionIcon
              disabled={allProjects.length === 0 && debouncedSearchValue === ""}
              variant="transparent"
              onClick={() => setView("grid")}
              title={t`Grid view`}
              color={view === "grid" ? "blue" : "gray"}
            >
              <IconLayoutGrid />
            </ActionIcon>
          </Group>
        </Group>

        {allProjects.length === 0 && debouncedSearchValue === "" && (
          <CloseableAlert icon={<IconInfoCircle />}>
            <Trans>
              Welcome to Your Home! Here you can see all your projects and get
              access to tutorial resources. Currently, you have no projects.
              Click "Create" to configure to get started!
            </Trans>
          </CloseableAlert>
        )}

        {!(allProjects.length === 0 && debouncedSearchValue === "") && (
          <TextInput
            leftSection={<IconSearch />}
            rightSection={
              !!search && (
                <ActionIcon
                  disabled={isFetchingNextPage}
                  variant="transparent"
                  onClick={() => {
                    setSearch("");
                  }}
                >
                  <IconX />
                </ActionIcon>
              )
            }
            placeholder={t`Search projects`}
            value={search}
            size="md"
            onChange={(e) => setSearch(e.currentTarget.value)}
            className="w-full"
          />
        )}

        {allProjects.length === 0 && debouncedSearchValue !== "" && (
          <Text>
            <Trans>No projects found for search term</Trans>{" "}
            <i>{debouncedSearchValue}</i>
          </Text>
        )}

        {isError && (
          <Alert color="red" title="Error">
            {getDirectusErrorString(error)}
          </Alert>
        )}

        <Box className="relative">
          {view === "grid" && (
            <Box
              ref={gridParent}
              className="grid grid-cols-12 place-content-stretch gap-4"
            >
              {allProjects.map((project) => (
                <Box
                  key={project.id}
                  className="col-span-full h-full md:col-span-4"
                  ref={
                    allProjects[allProjects.length - 1].id === project.id
                      ? loadMoreRef
                      : undefined
                  }
                >
                  <ProjectCard project={project as Project} />
                </Box>
              ))}
              {isFetchingNextPage &&
                Array.from({ length: 3 }).map((_, i) => (
                  <Box key={i} className="col-span-full h-full md:col-span-4">
                    <Skeleton height={80} radius="md" />
                  </Box>
                ))}
            </Box>
          )}

          {view === "list" && (
            <Stack ref={listParent} gap="sm">
              {allProjects.map((project) => (
                <Box
                  key={project.id}
                  ref={
                    allProjects[allProjects.length - 1].id === project.id
                      ? loadMoreRef
                      : undefined
                  }
                >
                  <ProjectListItem project={project as Project} />
                </Box>
              ))}
              {isFetchingNextPage && (
                <>
                  <Skeleton height={60} radius="md" />
                  <Skeleton height={60} radius="md" />
                  <Skeleton height={60} radius="md" />
                </>
              )}
            </Stack>
          )}
        </Box>
      </Stack>
    </Container>
  );
};
