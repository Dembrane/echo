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
} from "@mantine/core";
import { useDebouncedValue, useDocumentTitle } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import { IconSearch, IconSettings, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useSearchParams } from "react-router";
import { useCurrentUser } from "@/components/auth/hooks";
import { AccessDeniedPanel } from "@/components/common/AccessDeniedPanel";
import { toast } from "@/components/common/Toaster";
import { useTogglePinMutation } from "@/components/project/hooks";
import { PinnedProjectCard } from "@/components/project/PinnedProjectCard";
import { ProjectListItem } from "@/components/project/ProjectListItem";
import { ProjectListSkeleton } from "@/components/project/ProjectListSkeleton";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceProjects } from "@/hooks/useWorkspaceProjects";
import { Icons } from "@/icons";
import { WorkspaceAccessDeniedError } from "@/lib/accessDenied";
import { getDirectusErrorString } from "@/lib/directus";
import { testId } from "@/lib/testUtils";
import { formatDurationFromHours } from "@/lib/time";

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
		enabled: Boolean(isPilot && workspaceId),
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
		queryKey: ["v2", "workspace-usage", workspaceId, 0],
		staleTime: 60_000,
	});

	// Workspace-scoped only; the legacy /projects/home query (v1) is gone.
	// The hook is disabled until workspaceId resolves, which keeps the
	// skeleton up instead of firing a workspace-less request.
	const {
		data: homeData,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		status,
		isError,
		error,
	} = useWorkspaceProjects({
		search: debouncedSearchValue,
	});

	const togglePinMutation = useTogglePinMutation();

	useEffect(() => {
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				if (search) {
					next.set("search", search);
				} else {
					next.delete("search");
				}
				return next;
			},
			{ replace: true },
		);
	}, [search, setSearchParams]);

	useEffect(() => {
		if (inView && hasNextPage && !isFetchingNextPage) {
			fetchNextPage();
		}
	}, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

	const navigate = useI18nNavigate();
	const user = useCurrentUser();
	const posthog = usePostHog();

	const handleCreateProject = () => {
		// Route to the creation wizard (name → access → review). Matches the
		// workspace creation flow — a few deliberate steps instead of an
		// instant POST that leaves the new project with a "New Project"
		// placeholder name. See CreateProjectRoute.tsx.
		posthog?.capture("project_create_started");
		if (!workspaceId) return;
		navigate(`/w/${workspaceId}/projects/new`);
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
	// Externals cannot create projects or pin — their surface is
	// view-only on the workspace level. Gate the CTAs up front so we
	// don't lure them into a click that 403s.
	const isExternal = workspace?.role === "external";
	const canCreateProject = !isExternal && !user.data?.disable_create_project;
	const canPinOnThisWorkspace = !isExternal;
	const totallyEmpty =
		allProjects.length === 0 &&
		debouncedSearchValue === "" &&
		status === "success";

	// Without this, a 403 falls through to the empty-state and reads as "no projects yet."
	if (isError && error instanceof WorkspaceAccessDeniedError) {
		return <AccessDeniedPanel testId="workspace-projects-access-denied" />;
	}

	return (
		<Container size="xl" px="lg" py="xl">
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
								<Button
									variant="subtle"
									size="xs"
									color="gray"
									leftSection={<IconSettings size={14} />}
									onClick={() => navigate(`/w/${workspace.id}/settings`)}
								>
									<Trans>Settings</Trans>
								</Button>
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
				    has zero projects and no search. Guests (externals) see a
				    different copy since they can't create: the current state
				    for them isn't "empty, go make something" — it's "nothing
				    has been shared with you yet." */}
				{totallyEmpty ? (
					<Stack gap={12} py={48}>
						<Title order={3} fw={400}>
							{isExternal ? (
								<Trans>Nothing here for you yet.</Trans>
							) : (
								<Trans>Let's hear your first conversation.</Trans>
							)}
						</Title>
						<Text size="sm" maw={440}>
							{isExternal ? (
								<Trans>
									You're an external in this workspace. Projects will show up
									here once someone on the organisation shares one with you.
								</Trans>
							) : (
								<Trans>
									A project holds everything for one topic. Share its link with
									participants, gather voices, then let dembrane turn them into
									insights.
								</Trans>
							)}
						</Text>
						{canCreateProject && (
							<Button
								size="sm"
								w="fit-content"
								rightSection={<Icons.Plus stroke="white" fill="white" />}
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
											onSearchOwner={isAdmin ? handleSearchOwner : undefined}
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
										rightSection={<Icons.Plus stroke="white" fill="white" />}
										onClick={handleCreateProject}
										{...testId("project-home-create-button")}
									>
										<Trans>Create</Trans>
									</Button>
								)}
							</Group>

							<TextInput
								leftSection={<IconSearch {...testId("project-search-icon")} />}
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
											Everything is pinned. Unpin a project to see it in this
											list.
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
													nonPinnedProjects[nonPinnedProjects.length - 1].id ===
													project.id
														? loadMoreRef
														: undefined
												}
											>
												<ProjectListItem
													project={project as Project}
													onTogglePin={
														canPinOnThisWorkspace ? handleTogglePin : undefined
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
function PilotHoursInline({
	usage,
}: {
	usage: { audio_hours: number; audio_hours_included: number | null };
}) {
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
			{formatDurationFromHours(used)} of {cap}h
		</Badge>
	);
}
