import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Container,
	Group,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDebouncedValue, useDocumentTitle } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import { IconSearch, IconSettings, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/auth/hooks";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
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
	useDocumentTitle(t`Projects | dembrane`);

	const [listParent] = useAutoAnimate();
	const [searchParams, setSearchParams] = useSearchParams();
	const initialSearch = searchParams.get("search") || "";
	const [search, setSearch] = useState(initialSearch);

	const [debouncedSearchValue] = useDebouncedValue(search, 200);

	const { ref: loadMoreRef, inView } = useInView();

	const { workspaceId, workspace } = useWorkspace();

	// Pilot is the only tier with a hard hour cap, so we surface the
	// hour count inline in the header. Other tiers hide usage by default
	// per audit §1 — the projects page is about project selection, not
	// quota monitoring.
	const isPilot = workspace?.tier === "pilot";
	const { data: pilotHours } = useQuery({
		queryKey: ["v2", "workspace-usage", workspaceId, 0],
		queryFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/usage`,
				{ credentials: "include" },
			);
			if (!res.ok) return null;
			return res.json() as Promise<{
				audio_hours: number;
				audio_hours_included: number | null;
			}>;
		},
		enabled: Boolean(isPilot && workspaceId),
		staleTime: 60_000,
	});

	// Use v2 (workspace-scoped) when workspace context exists, v1 otherwise
	const v1Query = useProjectsHome({
		search: debouncedSearchValue,
		workspaceId,
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

	// Pinned rail shouldn't also appear in the "All projects" list —
	// audit 2026-04-23 called the duplication out. One surface per project.
	const nonPinnedProjects = useMemo(
		() => allProjects.filter((p) => !pinnedIds.has(p.id)),
		[allProjects, pinnedIds],
	);

	const canManageWorkspace =
		workspace?.role === "owner" || workspace?.role === "admin";
	// Guests (external workspace access) cannot create projects or pin —
	// their surface is view-only on the workspace level. Gate the CTAs
	// up front so we don't lure them into a click that 403s.
	const isExternalGuest = workspace?.is_external === true;
	const canCreateProject =
		!isExternalGuest && !user.data?.disable_create_project;
	const canPinOnThisWorkspace = !isExternalGuest;
	const totallyEmpty =
		allProjects.length === 0 &&
		debouncedSearchValue === "" &&
		status === "success";

	return (
		<Container>
			<Stack gap="lg">
				{/* Quiet workspace identity — replaces the old tier-card hero.
				    Per audit §1: the user is deciding WHICH project to open;
				    the workspace name is context, not content. */}
				{workspace && (
					<Stack gap={4}>
						<Group justify="space-between" align="flex-start" wrap="nowrap">
							<Title order={2} fw={500} lineClamp={1}>
								{workspace.name}
							</Title>
							{canManageWorkspace && (
								<Tooltip label={t`Workspace settings`}>
									<ActionIcon
										variant="subtle"
										color="gray"
										size="lg"
										onClick={() =>
											navigate(`/w/${workspace.id}/settings`)
										}
										aria-label={t`Workspace settings`}
									>
										<IconSettings size={16} />
									</ActionIcon>
								</Tooltip>
							)}
						</Group>
						<Text size="sm" c="dimmed">
							<Plural
								value={workspace.member_count}
								one="# member"
								other="# members"
							/>
							{" · "}
							<span style={{ textTransform: "capitalize" }}>
								{workspace.tier}
							</span>
							{/* Pilot is the only tier with a hard hour block,
							    so spell out the hour count inline — audit §1. */}
							{isPilot && pilotHours && (
								<>
									{" · "}
									<PilotHoursInline usage={pilotHours} />
								</>
							)}
						</Text>
					</Stack>
				)}

				{/* Hero empty state — skip everything else when the workspace
				    has zero projects and no search. */}
				{totallyEmpty ? (
					<Stack align="center" gap={12} py={48}>
						<Title order={3} fw={400}>
							<Trans>Your workspace is ready.</Trans>
						</Title>
						<Text size="sm" c="dimmed" ta="center" maw={420}>
							<Trans>
								Projects are where conversations happen — create your
								first one to get started.
							</Trans>
						</Text>
						{canCreateProject && (
							<Button
								size="sm"
								rightSection={<Icons.Plus stroke="white" fill="white" />}
								loading={createProjectMutation.isPending}
								onClick={handleCreateProject}
								{...testId("project-home-create-button")}
							>
								<Trans>Create project</Trans>
							</Button>
						)}
					</Stack>
				) : (
					<>
						{/* Pinned section — cards at the top, hidden when empty. */}
						{showPinnedSection && (
							<Stack gap="sm">
								<Title order={5} fw={400} c="dimmed">
									<Trans>Pinned</Trans>
								</Title>
								<SimpleGrid cols={{ base: 1, md: 3, sm: 2 }} spacing="md">
									{pinnedProjects.map((project) => (
										<PinnedProjectCard
											key={project.id}
											project={project as Project}
											onUnpin={
												canPinOnThisWorkspace ? handleTogglePin : undefined
											}
											isUnpinning={togglePinMutation.isPending}
											onSearchOwner={
												isAdmin ? handleSearchOwner : undefined
											}
										/>
									))}
								</SimpleGrid>
							</Stack>
						)}

						{/* All projects section — search lives inside this section
						    (audit §1), Create button on the header row. */}
						<Stack gap="sm">
							<Group justify="space-between" align="center">
								<Title order={5} fw={400}>
									<Trans>All projects</Trans>
								</Title>
								{canCreateProject && (
									<Button
										size="sm"
										rightSection={
											<Icons.Plus stroke="white" fill="white" />
										}
										loading={createProjectMutation.isPending}
										onClick={handleCreateProject}
										{...testId("project-home-create-button")}
									>
										<Trans>Create</Trans>
									</Button>
								)}
							</Group>

							<TextInput
								leftSection={
									<IconSearch {...testId("project-search-icon")} />
								}
								rightSection={
									!!search && (
										<ActionIcon
											disabled={isFetchingNextPage}
											variant="transparent"
											onClick={() => setSearch("")}
											aria-label={t`Clear search`}
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

							{nonPinnedProjects.length === 0 &&
								debouncedSearchValue !== "" &&
								status === "success" && (
									<Text c="dimmed">
										<Trans>No projects found for search term</Trans>{" "}
										<i>{debouncedSearchValue}</i>
									</Text>
								)}

							{nonPinnedProjects.length === 0 &&
								debouncedSearchValue === "" &&
								status === "success" &&
								showPinnedSection && (
									<Text size="sm" c="dimmed">
										<Trans>
											Everything is pinned. Unpin a project to see it
											in this list.
										</Trans>
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

							{nonPinnedProjects.length > 0 && (
								<Box className="relative">
									<Stack ref={listParent} gap="sm">
										{nonPinnedProjects.map((project) => (
											<Box
												key={project.id}
												ref={
													nonPinnedProjects[nonPinnedProjects.length - 1]
														.id === project.id
														? loadMoreRef
														: undefined
												}
											>
												<ProjectListItem
													project={project as Project}
													onTogglePin={
														canPinOnThisWorkspace
															? handleTogglePin
															: undefined
													}
													isPinned={pinnedIds.has(project.id)}
													canPin={canPin && canPinOnThisWorkspace}
													onSearchOwner={
														isAdmin ? handleSearchOwner : undefined
													}
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
					</>
				)}
			</Stack>
		</Container>
	);
};

// Fetches just enough for the Pilot inline hour indicator. Uses the
// same /usage query key the Billing card uses so they share cache.
function PilotHoursInline({ usage }: { usage: { audio_hours: number; audio_hours_included: number | null } }) {
	const used = usage.audio_hours;
	const cap = usage.audio_hours_included;
	if (cap == null) return null;
	const pct = cap > 0 ? used / cap : 0;
	const color =
		pct >= 1 ? "red" : pct >= 0.95 ? "red" : pct >= 0.8 ? "yellow" : "dimmed";
	return (
		<Badge
			size="xs"
			variant={color === "dimmed" ? "transparent" : "light"}
			color={color === "dimmed" ? "gray" : color}
		>
			{used.toFixed(1)} of {cap} hours
		</Badge>
	);
}
