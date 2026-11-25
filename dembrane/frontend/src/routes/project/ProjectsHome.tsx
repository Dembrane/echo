import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Checkbox,
	Container,
	Group,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import {
	useDebouncedValue,
	useDisclosure,
	useDocumentTitle,
} from "@mantine/hooks";
import {
	GearIcon,
	MagnifyingGlassIcon,
	TrayArrowUp,
	XIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useSearchParams } from "react-router";
import { useCurrentUser } from "@/components/auth/hooks";
import { AccessDeniedPanel } from "@/components/common/AccessDeniedPanel";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { BulkMoveProjectsModal } from "@/components/project/BulkMoveProjectsModal";
import { useTogglePinMutation } from "@/components/project/hooks";
import { PinnedProjectCard } from "@/components/project/PinnedProjectCard";
import { ProjectListItem } from "@/components/project/ProjectListItem";
import { ProjectListSkeleton } from "@/components/project/ProjectListSkeleton";
import {
	CreateMenu,
	type ProjectStart,
} from "@/components/workspace/CreateMenu/CreateMenu";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { API_BASE_URL } from "@/config";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useProjectCap } from "@/hooks/useProjectCap";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceProjects } from "@/hooks/useWorkspaceProjects";
import { WorkspaceAccessDeniedError } from "@/lib/accessDenied";
import { track } from "@/lib/analytics/events";
import { isAdminRole, isOutsiderRole, isReadOnlyRole } from "@/lib/roles";
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
	// Create (the menu on the "All projects" row): Quick project opens the name step with
	// Quick start chosen, so the choice is counted here; the template screen counts its own.
	const startProject = (id: string, start: ProjectStart) => {
		track("project_create_started");
		if (start === "template") {
			navigate(`/w/${id}/projects/new`);
			return;
		}
		track("project_template_selected", {
			featured: false,
			filters_active: [],
			setup: null,
			surface: "workspace_home",
			template_key: "blank",
			verbs: [],
		});
		navigate(`/w/${id}/projects/new?template=blank`);
	};
	// At the free project cap the button opens the wall where it is instead of the menu.
	const atProjectCap = useProjectCap(workspace);
	const [capWallOpened, capWall] = useDisclosure(false);

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
	// Pinned projects also appear in the default "All projects" list as a
	// shortcut (they're not removed from it), so the list — and the bulk-move
	// selection — operate on the full set.
	const displayProjects = allProjects;

	const selectableIds = useMemo(
		() => displayProjects.map((p) => p.id),
		[displayProjects],
	);
	const selection = useBulkSelection(selectableIds);
	const [moveOpen, moveHandlers] = useDisclosure(false);
	// Select mode is off by default: the checkboxes only appear once the user
	// clicks "Select", keeping the list clean for the common (browse) case.
	const [selectMode, setSelectMode] = useState(false);

	const exitSelectMode = useCallback(() => {
		selection.clear();
		setSelectMode(false);
	}, [selection]);

	const canManageWorkspace =
		workspace?.role === "owner" || workspace?.role === "admin";
	// Outsiders (external + observer) can't create projects or pin; gate the CTAs
	// up front so we don't lure them into a click that 403s.
	const isOutsider = isOutsiderRole(workspace?.role);
	const canCreateProject = !isOutsider && !user.data?.disable_create_project;
	const canPinOnThisWorkspace = !isOutsider;
	// Observers lack project:update; externals keep it.
	const canEditProjects = !!workspace && !isReadOnlyRole(workspace.role);
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
					<Stack gap="xs">
						<Group justify="space-between" align="flex-start" wrap="nowrap">
							<Title order={2} lineClamp={1}>
								{workspace.name}
							</Title>
							{canManageWorkspace && (
								<Button
									variant="subtle"
									size="xs"
									color="gray"
									leftSection={<GearIcon size={20} />}
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

				{/* A guest with nothing shared yet: there is nothing to search or create, so
				    the page says why it is empty instead of showing an empty list. */}
				{totallyEmpty && isOutsider ? (
					<Stack gap="md" py="xl">
						<Title order={3}>
							<Trans>Nothing here for you yet.</Trans>
						</Title>
						<Text size="sm" maw={440}>
							<Trans>
								Projects will show up here once someone on the organisation
								shares one with you.
							</Trans>
						</Text>
					</Stack>
				) : (
					<>
						{/* Pinned section — cards at the top, hidden when empty. */}
						{showPinnedSection && (
							<Stack gap="sm">
								<Title order={5}>
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

						{/* All projects section: search lives inside this section
						    (audit §1), Create on the header row: the two project items
						    only, a plus alone on a phone. */}
						<Stack gap="sm">
							<Group justify="space-between" align="center" wrap="nowrap">
								<Title order={5}>
									<Trans>All projects</Trans>
								</Title>
								{canCreateProject && workspace && (
									<CreateMenu
										projectWorkspaces={[
											{
												id: workspace.id,
												name: workspace.name,
												orgName: workspace.org_name,
											},
										]}
										onProject={startProject}
										onProjectCap={atProjectCap ? capWall.open : undefined}
									/>
								)}
							</Group>

							<TextInput
								leftSection={
									<MagnifyingGlassIcon
										size={16}
										{...testId("project-search-icon")}
									/>
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
											<XIcon size={16} />
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

							{totallyEmpty && (
								<Text size="sm" c="dimmed" maw={560}>
									<Trans>
										Your projects will appear here. A project holds everything
										for one topic: the link participants record on, their
										conversations, and what dembrane makes of them.
									</Trans>
								</Text>
							)}

							{displayProjects.length === 0 &&
								debouncedSearchValue !== "" &&
								status === "success" && (
									<Text size="sm" c="dimmed">
										<Trans>No projects found for search term</Trans>{" "}
										<i>{debouncedSearchValue}</i>
									</Text>
								)}

							{isError && <ErrorNotice error={error} />}

							{status === "pending" && (
								<ProjectListSkeleton searchValue={debouncedSearchValue} />
							)}

							{/* Bulk-move affordance (admin/owner only). A quiet "Select"
							    button on the right turns on select mode; the row then
							    becomes select-all + Move + Cancel. No divider borders. */}
							{canManageWorkspace &&
								displayProjects.length > 0 &&
								(selectMode ? (
									<Group
										justify="flex-start"
										align="center"
										gap="md"
										wrap="nowrap"
									>
										<Checkbox
											checked={selection.allSelected}
											indeterminate={selection.someSelected}
											onChange={selection.toggleAll}
											data-testid="projects-select-all"
											label={
												<Text size="sm">
													{selection.count > 0 ? (
														<Plural
															value={selection.count}
															one="# selected"
															other="# selected"
														/>
													) : (
														<Trans>Select all</Trans>
													)}
												</Text>
											}
										/>
										<Group gap="xs" wrap="nowrap">
											{selection.count > 0 && (
												<Button
													size="xs"
													leftSection={<TrayArrowUp size={20} />}
													onClick={moveHandlers.open}
													data-testid="projects-bulk-move"
												>
													<Trans>Move projects</Trans>
												</Button>
											)}
											<Button
												variant="subtle"
												size="xs"
												color="gray"
												onClick={exitSelectMode}
												data-testid="projects-select-cancel"
											>
												<Trans>Cancel</Trans>
											</Button>
										</Group>
									</Group>
								) : (
									<Group justify="flex-start">
										<Button
											variant="subtle"
											size="xs"
											onClick={() => setSelectMode(true)}
											data-testid="projects-select-button"
										>
											<Trans>Select</Trans>
										</Button>
									</Group>
								))}

							{displayProjects.length > 0 && (
								<Box className="relative">
									<Stack ref={listParent} gap="sm">
										{displayProjects.map((project, index) => (
											<div
												key={project.id}
												ref={
													index === displayProjects.length - 1
														? loadMoreRef
														: undefined
												}
											>
												<ProjectListItem
													project={project as Project}
													// Pin and select are mutually exclusive interactions;
													// hide the pin while selecting so the row click is
													// unambiguous.
													onTogglePin={
														!selectMode && canPinOnThisWorkspace
															? handleTogglePin
															: undefined
													}
													isPinned={pinnedIds.has(project.id)}
													canPin={canPin && canPinOnThisWorkspace}
													canEdit={canEditProjects}
													onSearchOwner={
														isAdmin ? handleSearchOwner : undefined
													}
													selectable={selectMode && canManageWorkspace}
													selected={selection.isSelected(project.id)}
													onToggleSelect={() => selection.toggle(project.id)}
												/>
											</div>
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

							{workspace && (
								<UpgradeModal
									opened={capWallOpened}
									onClose={capWall.close}
									currentTier="free"
									requiredTier="changemaker"
									canRequestUpgrade={isAdminRole(workspace.role)}
									workspaceId={workspace.id}
									wallKey="project_cap"
								/>
							)}

							{workspaceId && (
								<BulkMoveProjectsModal
									opened={moveOpen}
									onClose={moveHandlers.close}
									projectIds={selection.selectedIds}
									sourceWorkspaceId={workspaceId}
									onMoved={selection.clear}
								/>
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
