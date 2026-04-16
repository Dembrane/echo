import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Box,
	Button,
	Container,
	Divider,
	Group,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDebouncedValue, useDocumentTitle } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import { IconInfoCircle, IconSearch, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useSearchParams } from "react-router";
import { useCurrentUser } from "@/components/auth/hooks";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { CloseableAlert } from "@/components/common/ClosableAlert";
import { toast } from "@/components/common/Toaster";
import {
	useCreateProjectMutation,
	useProjectsHome,
	useTogglePinMutation,
	useUpdateProjectByIdMutation,
} from "@/components/project/hooks";
import { PinnedProjectCard } from "@/components/project/PinnedProjectCard";
import { ProjectListItem } from "@/components/project/ProjectListItem";
import { ProjectListSkeleton } from "@/components/project/ProjectListSkeleton";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { useWorkspace } from "@/hooks/useWorkspace";
import {
	useWorkspaceProjects,
	useCreateWorkspaceProject,
} from "@/hooks/useWorkspaceProjects";
import { Icons } from "@/icons";
import { getDirectusErrorString } from "@/lib/directus";
import { testId } from "@/lib/testUtils";

const MAX_PINNED = 3;

export const ProjectsHomeRoute = () => {
	useDocumentTitle(t`Projects | Dembrane`);

	const [listParent] = useAutoAnimate();
	const [searchParams, setSearchParams] = useSearchParams();
	const initialSearch = searchParams.get("search") || "";
	const [search, setSearch] = useState(initialSearch);

	const [debouncedSearchValue] = useDebouncedValue(search, 200);

	const { ref: loadMoreRef, inView } = useInView();

	const { workspaceId } = useWorkspace();

	// Use v2 (workspace-scoped) when workspace context exists, v1 otherwise
	const v1Query = useProjectsHome({
		search: debouncedSearchValue,
	});
	const v2Query = useWorkspaceProjects({
		search: debouncedSearchValue,
	});

	const activeQuery = workspaceId ? v2Query : v1Query;
	const {
		data: homeData,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		status,
		isError,
		error,
	} = activeQuery;

	const togglePinMutation = useTogglePinMutation();

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

	const navigate = useI18nNavigate();
	const createProjectMutation = useCreateProjectMutation();
	const createWorkspaceProjectMutation = useCreateWorkspaceProject();
	const updateProjectMutation = useUpdateProjectByIdMutation();
	const user = useCurrentUser();
	const posthog = usePostHog();

	const { language } = useLanguage();

	const handleCreateProject = async () => {
		const lang = language === "en-US" ? "en" : language === "nl-NL" ? "nl" : "en";

		let projectId: string;

		if (workspaceId) {
			// v2: creates with workspace_id already set
			const project = await createWorkspaceProjectMutation.mutateAsync({
				name: t`New Project`,
				language: lang,
			});
			projectId = project.id;
		} else {
			// v1 fallback: legacy create
			const project = await createProjectMutation.mutateAsync({
				language: lang,
				name: t`New Project`,
			});
			projectId = project.id;
		}

		await updateProjectMutation.mutateAsync({
			id: projectId,
			payload: {
				default_conversation_ask_for_participant_name: true,
				default_conversation_tutorial_slug: "None",
				image_generation_model: "MODEST",
			},
		});

		posthog?.capture("project_created", { project_id: projectId });
		navigate(`/projects/${projectId}/overview`);
	};

	// First page has pinned + total_count; all pages have projects
	const firstPage = homeData?.pages?.[0];
	const pinnedProjects = firstPage?.pinned ?? [];
	const allProjects = homeData?.pages?.flatMap((page) => page.projects) ?? [];

	const isAdmin = firstPage?.is_admin ?? false;

	const pinnedIds = useMemo(
		() => new Set(pinnedProjects.map((p) => p.id)),
		[pinnedProjects],
	);

	const canPin = pinnedProjects.length < MAX_PINNED;
	const showPinnedSection = pinnedProjects.length > 0 && !debouncedSearchValue;

	const getNextPinOrder = useCallback(() => {
		const usedOrders = new Set(
			pinnedProjects.map((p) => p.pin_order).filter(Boolean),
		);
		for (let i = 1; i <= MAX_PINNED; i++) {
			if (!usedOrders.has(i)) return i;
		}
		return null;
	}, [pinnedProjects]);

	const handleSearchOwner = useCallback((term: string) => {
		setSearch(`owner:${term}`);
	}, []);

	const handleTogglePin = useCallback(
		(projectId: string) => {
			if (pinnedIds.has(projectId)) {
				togglePinMutation.mutate({ pin_order: null, projectId });
			} else {
				const nextOrder = getNextPinOrder();
				if (nextOrder === null) {
					toast.error(t`Unpin a project first (max ${MAX_PINNED})`);
					return;
				}
				togglePinMutation.mutate({ pin_order: nextOrder, projectId });
			}
		},
		[pinnedIds, getNextPinOrder, togglePinMutation],
	);

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
											<Title order={2}>
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
							{...testId("project-home-create-button")}
						>
							<Trans>Create</Trans>
						</Button>
					)}
				</Group>
				<Divider />

				{/* Pinned Projects Section */}
				{showPinnedSection && (
					<>
						<SimpleGrid cols={{ base: 1, md: 3, sm: 2 }} spacing="md">
							{pinnedProjects.map((project) => (
								<PinnedProjectCard
									key={project.id}
									project={project as Project}
									onUnpin={handleTogglePin}
									isUnpinning={togglePinMutation.isPending}
									onSearchOwner={isAdmin ? handleSearchOwner : undefined}
								/>
							))}
						</SimpleGrid>
						<Divider />
					</>
				)}

				<Group justify="space-between" className="relative">
					<Title order={3}>
						<Trans>Projects</Trans>
					</Title>
				</Group>

				{allProjects.length === 0 &&
					debouncedSearchValue === "" &&
					status === "success" && (
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
						leftSection={<IconSearch {...testId("project-search-icon")} />}
						rightSection={
							!!search && (
								<ActionIcon
									disabled={isFetchingNextPage}
									variant="transparent"
									onClick={() => {
										setSearch("");
									}}
									{...testId("project-search-clear-button")}
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
						{...testId("project-search-input")}
					/>
				)}

				{allProjects.length === 0 &&
					debouncedSearchValue !== "" &&
					status === "success" && (
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

				{status === "pending" && (
					<ProjectListSkeleton searchValue={debouncedSearchValue} />
				)}

				{allProjects.length > 0 && (
					<Box className="relative">
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
									<ProjectListItem
										project={project as Project}
										onTogglePin={handleTogglePin}
										isPinned={pinnedIds.has(project.id)}
										canPin={canPin}
										onSearchOwner={isAdmin ? handleSearchOwner : undefined}
									/>
								</Box>
							))}

							{isFetchingNextPage && (
								<ProjectListSkeleton
									searchValue={"none"}
									count={3}
									wrapper={false}
								/>
							)}
						</Stack>
					</Box>
				)}
			</Stack>
		</Container>
	);
};
