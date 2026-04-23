import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Anchor,
	Avatar,
	Badge,
	Box,
	Button,
	Center,
	Container,
	FileButton,
	Group,
	Image,
	Loader,
	Menu,
	Paper,
	SegmentedControl,
	Stack,
	Table,
	Tabs,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { useDocumentTitle } from "@mantine/hooks";
import {
	IconChevronDown,
	IconLock,
	IconSearch,
	IconSettings,
	IconTrash,
	IconUpload,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { TeamProjectsTable } from "@/components/workspace/TeamProjectsTable";
import { TeamUsageRollup } from "@/components/workspace/TeamUsageRollup";
import { TierBadge } from "@/components/workspace/TierBadge";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useUrlSearch } from "@/hooks/useUrlSearch";
import { useSearchParams } from "react-router";
import { avatarUrl, logoUrl as resolveLogoUrl } from "@/lib/avatar";
import { displayRole, roleColor } from "@/lib/roles";

/**
 * Team admin page — single-page matrix view.
 *
 * Design call (2026-04-21): collapse the previous 3-tab layout (Members /
 * Matrix / Workspaces) into one canvas with the matrix as primary content.
 * The matrix rows already ARE the member list; the columns are the
 * workspaces. A secondary Drawer houses workspace management; everything
 * else is inline.
 */

interface TeamDetail {
	id: string;
	name: string;
	logo_url: string | null;
	role: string;
	member_count: number;
	workspace_count: number;
	external_count: number;
}

interface TeamMember {
	user_id: string;
	app_user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	role: string;
	accessible_workspace_count: number;
	is_pending: boolean;
	// workspace_id → role for direct memberships (not derived).
	direct_workspace_roles?: Record<string, string>;
}

interface TeamWorkspace {
	id: string;
	name: string;
	tier: string;
	is_default: boolean;
	project_count: number;
	member_count: number;
	is_private: boolean;
}

async function fetchTeam(teamId: string): Promise<TeamDetail | null> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

async function fetchTeamMembers(teamId: string): Promise<TeamMember[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}/members`, {
		credentials: "include",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		// Bubble up the error instead of silently falling through to an
		// empty list — the "0 of 0" symptom in the 2026-04-23 audit was
		// a swallowed 500 masquerading as an empty team.
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: `Members request failed (${res.status})`,
		);
	}
	return res.json();
}

async function fetchTeamWorkspaces(teamId: string): Promise<TeamWorkspace[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}/workspaces`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

type RoleFilter = "all" | "admins" | "members";

// Role options by scope + caller role. Team-level doesn't include
// Matrix §5 retires "owner" as a user-facing role — it's a backend-only
// distinction kept for last-admin protection + ownership transfer
// mechanics. The UI offers only Admin and Member (+ Billing on
// workspaces), and any "owner" record displays as "Admin" through
// displayRole(). Ownership transfer is a separate staff/support flow,
// not a role picker.
const TEAM_ROLE_OPTIONS = ["member", "admin"] as const;
const WS_ROLE_OPTIONS = ["member", "billing", "admin"] as const;

interface RoleBadgeMenuProps {
	currentRole: string;
	options: readonly string[];
	onChange: (next: string) => void;
	disabled?: boolean;
	size?: "xs" | "sm" | "md";
}

function RoleBadgeMenu({
	currentRole,
	options,
	onChange,
	disabled,
	size = "sm",
}: RoleBadgeMenuProps) {
	if (disabled) {
		return (
			<Badge size={size} variant="light" color={roleColor(currentRole)}>
				{displayRole(currentRole)}
			</Badge>
		);
	}
	return (
		<Menu shadow="md" width={140} position="bottom-start">
			<Menu.Target>
				<Badge
					size={size}
					variant="light"
					color={roleColor(currentRole)}
					style={{ cursor: "pointer" }}
					rightSection={<IconChevronDown size={10} />}
				>
					{displayRole(currentRole)}
				</Badge>
			</Menu.Target>
			<Menu.Dropdown>
				{options.map((role) => (
					<Menu.Item
						key={role}
						disabled={role === currentRole}
						onClick={() => onChange(role)}
					>
						{displayRole(role)}
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
}

async function changeTeamRole(
	orgId: string,
	userId: string,
	role: string,
): Promise<void> {
	const res = await fetch(
		`${API_BASE_URL}/v2/orgs/${orgId}/members/${userId}`,
		{
			body: JSON.stringify({ role }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Couldn't change role",
		);
	}
}

async function changeWorkspaceMemberRole(
	workspaceId: string,
	membershipId: string,
	role: string,
): Promise<void> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/members/${membershipId}`,
		{
			body: JSON.stringify({ role }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Couldn't change role",
		);
	}
}


export const TeamRoute = () => {
	const { teamId, "*": splat } = useParams<{
		teamId: string;
		"*": string;
	}>();
	const navigate = useI18nNavigate();
	const [search, setSearch] = useUrlSearch();
	const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
	const queryClient = useQueryClient();
	// URL-driven tab state. Tab lives in the path segment
	// (`/t/:teamId/<tab>`) so browser back steps between tabs and URLs
	// are shareable. Legacy ?tab=X query param is still honored as a
	// one-time bounce for bookmarks.
	const [searchParams] = useSearchParams();
	const legacyTab = searchParams.get("tab");
	const allowedTabs = ["overview", "usage", "people", "projects"] as const;
	type TabValue = (typeof allowedTabs)[number];
	const segment = (splat ?? "").split("/")[0] || "";
	const viewRaw: TabValue =
		(allowedTabs as readonly string[]).includes(segment)
			? (segment as TabValue)
			: (legacyTab &&
						(allowedTabs as readonly string[]).includes(legacyTab)
					? (legacyTab as TabValue)
					: "overview");

	useEffect(() => {
		if (!teamId) return;
		// Bounce legacy ?tab=X URLs and bare /t/:id to the canonical
		// /t/:id/<tab> form so back/forward + copy-paste always show
		// the same URL for the same view.
		const currentSegment = segment;
		const canonical = currentSegment === viewRaw && !legacyTab;
		if (!canonical) {
			navigate(`/t/${teamId}/${viewRaw}`, { replace: true });
		}
	}, [legacyTab, teamId, viewRaw, segment]);

	const setView = (value: string | null) => {
		if (!value || !teamId) return;
		navigate(`/t/${teamId}/${value}`, { replace: true });
	};

	useDocumentTitle(t`Team | dembrane`);

	const { data: team, isLoading: teamLoading } = useQuery({
		queryKey: ["v2", "team", teamId],
		queryFn: () => fetchTeam(teamId as string),
		enabled: Boolean(teamId),
		staleTime: 30_000,
	});
	const { data: members = [], error: membersError } = useQuery({
		queryKey: ["v2", "team", teamId, "members"],
		queryFn: () => fetchTeamMembers(teamId as string),
		enabled: Boolean(teamId),
		retry: 1,
	});
	const { data: workspaces = [] } = useQuery({
		queryKey: ["v2", "team", teamId, "workspaces"],
		queryFn: () => fetchTeamWorkspaces(teamId as string),
		enabled: Boolean(teamId),
	});

	const isAdmin = team?.role === "owner" || team?.role === "admin";
	const isOwner = team?.role === "owner";
	// Admin-only views fall back to People for other roles so landing
	// state is never an empty panel for them.
	const view: TabValue =
		!isAdmin && viewRaw === "usage" ? "people" : viewRaw;

	// Team-level role change — admin + owner can edit; owner-only offers
	// the "owner" option (only owners can grant owner).
	const teamRoleMutation = useMutation({
		mutationFn: ({ userId, role }: { userId: string; role: string }) => {
			if (!teamId) throw new Error("No team");
			return changeTeamRole(teamId, userId, role);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "team", teamId, "members"],
			});
			toast.success(t`Role changed`);
		},
		onError: (e: Error) => toast.error(e.message),
	});

	const filteredMembers = useMemo(() => {
		const q = search.trim().toLowerCase();
		return members.filter((m) => {
			// Matrix §5: team-level roles are Admin / Billing / Member.
			// No team-level Guest — guests exist only at the workspace
			// level. Filter collapses owner → admin for display.
			if (roleFilter === "admins" && !(m.role === "owner" || m.role === "admin"))
				return false;
			if (roleFilter === "members" && m.role !== "member") return false;
			if (!q) return true;
			return (
				(m.display_name || "").toLowerCase().includes(q) ||
				(m.email || "").toLowerCase().includes(q)
			);
		});
	}, [members, search, roleFilter]);

	if (teamLoading) {
		return (
			<Center style={{ height: "60vh" }}>
				<Loader size="sm" color="gray" />
			</Center>
		);
	}

	if (!team) {
		return (
			<Center style={{ height: "60vh" }}>
				<Stack align="center">
					<Title order={3} fw={400}>
						<Trans>Team not found</Trans>
					</Title>
					<Button variant="default" onClick={() => navigate("/w")}>
						<Trans>Back</Trans>
					</Button>
				</Stack>
			</Center>
		);
	}

	return (
		<Container size="xl" py="xl" px="lg">
			<Stack gap={24}>
				{/* Header — minimal. Name + counts on the left, action cluster
				    on the right. Tier is intentionally absent (it's a
				    per-workspace concept, shown in the column headers). */}
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Group gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
						{team.logo_url && (
							<Avatar src={resolveLogoUrl(team.logo_url)} size={40} radius="md" />
						)}
						<Stack gap={2} style={{ minWidth: 0 }}>
							<Title order={3} fw={400}>
								{team.name}
							</Title>
							<Text size="sm" c="dimmed">
								{team.workspace_count}{" "}
								{team.workspace_count === 1 ? t`workspace` : t`workspaces`} ·{" "}
								{team.member_count}{" "}
								{team.member_count === 1 ? t`person` : t`people`}
							</Text>
							{/* Matrix §5: team-level role set is Admin / Billing /
							    Member — no team-level Guest. Guest count intentionally
							    dropped from the header summary (HCD audit). */}
						</Stack>
					</Group>
					{/* Back link top-right per the canonical header pattern
					    (design review 2026-04-23). No gear icon — team-name
					    + logo editing live inline in the Overview tab. */}
					<Button
						variant="subtle"
						size="xs"
						color="gray"
						onClick={() => navigate("/w")}
					>
						<Trans>Back to workspaces</Trans>
					</Button>
				</Group>

				{/* Tabbed canvas per demo feedback. Overview holds team name
				    + logo (no more hunting for /t/:id/settings). Usage pulls
				    up the rollup + per-project table. People is the matrix.
				    Workspaces and Projects tabs retired — projects fold into
				    Usage; workspaces are reachable via the home selector. */}
				<Tabs
					value={view}
					onChange={setView}
					keepMounted={false}
				>
					<Tabs.List>
						<Tabs.Tab value="overview">
							<Trans>Overview</Trans>
						</Tabs.Tab>
						{isAdmin && (
							<Tabs.Tab value="usage">
								<Trans>Usage</Trans>
							</Tabs.Tab>
						)}
						<Tabs.Tab value="people">
							<Trans>People</Trans>
						</Tabs.Tab>
						{isAdmin && (
							<Tabs.Tab value="projects">
								<Trans>Projects</Trans>
							</Tabs.Tab>
						)}
					</Tabs.List>

					<Tabs.Panel value="overview" pt="md">
						<OverviewPanel
							team={team}
							teamId={teamId!}
							canEdit={isAdmin}
							queryClient={queryClient}
						/>
					</Tabs.Panel>

					{isAdmin && (
						<Tabs.Panel value="usage" pt="md">
							<Stack gap="md">
								{teamId && <TeamUsageRollup orgId={teamId} />}
							</Stack>
						</Tabs.Panel>
					)}

					{isAdmin && (
						<Tabs.Panel value="projects" pt="md">
							{teamId && <TeamProjectsTable orgId={teamId} />}
						</Tabs.Panel>
					)}

					<Tabs.Panel value="people" pt="md">
						<Stack gap="md">
				{/* Toolbar — people view. */}
				{true && (
					<Group justify="space-between" align="center" wrap="wrap">
						<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 280 }}>
							<TextInput
								leftSection={<IconSearch size={14} />}
								placeholder={t`Search name or email`}
								size="sm"
								value={search}
								onChange={(e) => setSearch(e.currentTarget.value)}
								style={{ flex: 1, maxWidth: 320 }}
							/>
							<SegmentedControl
								size="xs"
								value={roleFilter}
								onChange={(v) => setRoleFilter(v as RoleFilter)}
								data={[
									{ value: "all", label: t`All` },
									{ value: "admins", label: t`Admins` },
									{ value: "members", label: t`Members` },
								]}
							/>
						</Group>
						{membersError ? (
							<Text size="xs" c="red">
								<Trans>
									Couldn't load team members. Try refreshing — if it keeps
									failing, contact support.
								</Trans>
							</Text>
						) : (
							<Text size="xs" c="dimmed">
								<Trans>
									Showing {filteredMembers.length} of {members.length}
								</Trans>
							</Text>
						)}
					</Group>
				)}

				{/* Hero empty state — matches ProjectsHome pattern (audit §7).
				    A team with zero members is vanishingly rare in practice
				    (the team creator is always the first admin), but the
				    matrix rendered silently when it happened; surface that
				    instead so the state isn't "app looks broken." */}
				{!membersError && members.length === 0 && (
					<Stack align="center" gap={6} py={48}>
						<Title order={4} fw={400}>
							<Trans>No one on the team yet.</Trans>
						</Title>
						<Text size="sm" c="dimmed" ta="center" maw={400}>
							<Trans>
								Team members appear here once they join a workspace.
								Invites are sent from each workspace's Members tab.
							</Trans>
						</Text>
					</Stack>
				)}

				{/* Matrix — the main content. Sticky first column (name+email)
				    so it stays visible on horizontal scroll. Mantine Table
				    with stickyHeader + custom sticky-left on the first cell. */}
				{!membersError && members.length > 0 && (
				<Paper withBorder radius="md" style={{ overflowX: "auto" }}>
					<Table
						stickyHeader
						highlightOnHover
						verticalSpacing="sm"
						horizontalSpacing="sm"
					>
						<Table.Thead>
							<Table.Tr>
								<Table.Th
									style={{
										position: "sticky",
										left: 0,
										zIndex: 3,
										background: "var(--mantine-color-body)",
										minWidth: 260,
									}}
								>
									<Trans>Person</Trans>
								</Table.Th>
								<Table.Th style={{ minWidth: 90 }}>
									<Trans>Team role</Trans>
								</Table.Th>
								{workspaces.map((ws) => (
									<Table.Th
										key={ws.id}
										style={{ minWidth: 120, textAlign: "center" }}
									>
										<Stack gap={2} align="center">
											<Group gap={4} justify="center" wrap="nowrap">
												{ws.is_private && (
													<IconLock
														size={12}
														style={{
															color: "var(--mantine-color-gray-6)",
														}}
														aria-label={t`Private workspace`}
													/>
												)}
												<Tooltip label={ws.name} disabled={ws.name.length < 18}>
													{isAdmin ? (
														<Anchor
															size="sm"
															fw={500}
															c="dark"
															underline="hover"
															onClick={(e) => {
																e.preventDefault();
																navigate(`/w/${ws.id}/projects`);
															}}
															style={{ cursor: "pointer" }}
														>
															<Text size="sm" truncate maw={140}>
																{ws.name}
															</Text>
														</Anchor>
													) : (
														/* Matrix §6: team members don't auto-have access
														   to every team workspace. Linking non-admins to
														   /w/:id/projects would 403 for most. Plain text
														   instead; the discovery + Request-access path
														   lives on the home selector. */
														<Text
															size="sm"
															truncate
															maw={140}
															fw={500}
															c="dimmed"
														>
															{ws.name}
														</Text>
													)}
												</Tooltip>
											</Group>
											<Text size="xs" c="dimmed">
												<Plural
													value={ws.project_count}
													one="# project"
													other="# projects"
												/>
											</Text>
										</Stack>
									</Table.Th>
								))}
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{filteredMembers.map((m) => (
								<Table.Tr key={m.user_id}>
									<Table.Td
										style={{
											position: "sticky",
											left: 0,
											zIndex: 2,
											background: "var(--mantine-color-body)",
										}}
									>
										<Group gap="sm" wrap="nowrap">
											<Avatar
												src={avatarUrl(m.avatar, 48)}
												size="sm"
												radius="xl"
											>
												{(m.display_name || m.email || "?")
													.slice(0, 2)
													.toUpperCase()}
											</Avatar>
											<Stack gap={0} style={{ minWidth: 0 }}>
												<Text size="sm" truncate>
													{m.display_name || m.email || t`Unknown member`}
												</Text>
												{/* Email on its own line per design call —
												    two-line pattern beats a hover tooltip. */}
												{m.email && m.email !== m.display_name && (
													<Text size="xs" c="dimmed" truncate>
														{m.email}
													</Text>
												)}
											</Stack>
										</Group>
									</Table.Td>
									<Table.Td>
										<RoleBadgeMenu
											currentRole={m.role}
											options={TEAM_ROLE_OPTIONS}
											disabled={!isAdmin}
											onChange={(next) => {
												// Matrix row role changes get a confirm step — the
												// dense grid makes it too easy to misclick a
												// person's role. Matches the workspace-settings
												// self-demotion pattern.
												const person =
													m.display_name || m.email || t`this person`;
												modals.openConfirmModal({
													title: t`Change team role?`,
													children: (
														<Text size="sm">
															<Trans>
																Change {person}'s team role from{" "}
																<em>{displayRole(m.role)}</em> to{" "}
																<em>{displayRole(next)}</em>?
															</Trans>
														</Text>
													),
													labels: {
														confirm: t`Change role`,
														cancel: t`Cancel`,
													},
													onConfirm: () =>
														teamRoleMutation.mutate({
															userId: m.user_id,
															role: next,
														}),
												});
											}}
										/>
									</Table.Td>
									{workspaces.map((ws) => {
										// Direct membership takes priority. Backend returns
										// direct_workspace_roles = {workspace_id: role}
										// dedup'd against legacy inherited rows.
										const directRole =
											m.direct_workspace_roles?.[ws.id];
										// Derivation fallback: team owner has admin
										// everywhere; team admin has admin on non-private
										// workspaces. Post-walkback this derivation
										// retires — direct rows will be the sole source.
										const derivedAdmin =
											!directRole &&
											(m.role === "owner" ||
												(m.role === "admin" && !ws.is_private));
										const cellRole = directRole
											? directRole
											: derivedAdmin
												? "admin"
												: null;
										return (
											<Table.Td
												key={`${m.user_id}-${ws.id}`}
												style={{ textAlign: "center" }}
											>
												{cellRole ? (
													<Tooltip
														label={
															directRole
																? t`${displayRole(directRole)} on this workspace · change in workspace settings`
																: t`Admin here (from team role)`
														}
														withArrow
													>
														<Badge
															size="xs"
															variant="light"
															color={roleColor(cellRole)}
															style={{
																cursor: directRole ? "pointer" : undefined,
															}}
															onClick={
																directRole
																	? () =>
																			navigate(
																				`/w/${ws.id}/settings`,
																			)
																	: undefined
															}
														>
															{displayRole(cellRole)}
														</Badge>
													</Tooltip>
												) : ws.is_private && m.role === "admin" ? (
													<Tooltip
														label={t`Private workspace — ask a workspace admin for an invite`}
														withArrow
													>
														<Text size="xs" c="dimmed">
															—
														</Text>
													</Tooltip>
												) : (
													<Text size="xs" c="dimmed">
														—
													</Text>
												)}
											</Table.Td>
										);
									})}
								</Table.Tr>
							))}
							{filteredMembers.length === 0 && (
								<Table.Tr>
									<Table.Td
										colSpan={2 + workspaces.length}
										style={{ textAlign: "center", padding: "24px 12px" }}
									>
										<Text size="sm" c="dimmed">
											<Trans>No one matches that filter.</Trans>
										</Text>
									</Table.Td>
								</Table.Tr>
							)}
						</Table.Tbody>
					</Table>
				</Paper>
				)}

				<Text size="xs" c="dimmed">
					<Trans>
						Team admins can join any workspace to get a direct admin seat.
						Workspace invites live in each workspace's settings.
					</Trans>
				</Text>
						</Stack>
					</Tabs.Panel>
				</Tabs>
			</Stack>

		</Container>
	);
};

// ── Overview panel — team name + logo edit + counts ─────────────────

async function updateTeamFromOverview(
	teamId: string,
	body: { name?: string },
) {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}`, {
		body: JSON.stringify(body),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "PATCH",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Couldn't save",
		);
	}
	return res.json();
}

async function uploadTeamLogoInline(teamId: string, file: Blob, filename = "logo.png") {
	const body = new FormData();
	body.append("file", file, filename);
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}/logo`, {
		method: "POST",
		credentials: "include",
		body,
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Failed to upload logo",
		);
	}
	const data = await res.json();
	return data.file_id as string;
}

async function removeTeamLogoInline(teamId: string) {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}/logo`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Failed to remove logo",
		);
	}
}

function OverviewPanel({
	team,
	teamId,
	canEdit,
	queryClient,
}: {
	team: TeamDetail;
	teamId: string;
	canEdit: boolean;
	queryClient: ReturnType<typeof useQueryClient>;
}) {
	// Autosave on blur — matches the inline-edit pattern elsewhere in the
	// app (HostGuide titles, project portal). Local state lets the user
	// type without every keystroke round-tripping; blur commits.
	const [name, setName] = useState(team.name);
	const logoResetRef = useRef<() => void>(null);

	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: ["v2", "team", teamId] });
		queryClient.invalidateQueries({ queryKey: ["v2", "orgs"] });
		queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
	};

	const saveMutation = useMutation({
		mutationFn: (body: { name?: string }) =>
			updateTeamFromOverview(teamId, body),
		onSuccess: () => {
			invalidate();
			toast.success(t`Saved`);
		},
		onError: (err: Error) => {
			// Roll back local state on failure so what's shown matches
			// what's actually stored.
			setName(team.name);
			toast.error(err.message);
		},
	});
	const uploadLogoMutation = useMutation({
		mutationFn: (file: File) =>
			uploadTeamLogoInline(teamId, file, file.name || "logo.png"),
		onSuccess: () => {
			invalidate();
			toast.success(t`Logo updated`);
		},
		onError: (err: Error) => toast.error(err.message),
	});
	const removeLogoMutation = useMutation({
		mutationFn: () => removeTeamLogoInline(teamId),
		onSuccess: () => {
			invalidate();
			toast.success(t`Logo removed`);
		},
		onError: (err: Error) => toast.error(err.message),
	});
	const currentTeamLogoUrl = resolveLogoUrl(team.logo_url);

	const handleLogoSelect = (file: File | null) => {
		logoResetRef.current?.();
		if (!file) return;
		uploadLogoMutation.mutate(file);
	};

	return (
		<Stack gap="lg">
			{/* Team identity — name + logo. Admins edit inline; others read. */}
			<Stack gap="md">
				<TextInput
					label={t`Team name`}
					description={t`Shown in the team header and in email subject lines.`}
					value={name}
					disabled={!canEdit || saveMutation.isPending}
					onChange={(e) => setName(e.currentTarget.value)}
					onBlur={() => {
						const next = name.trim();
						if (next && next !== team.name) {
							saveMutation.mutate({ name: next });
						} else if (!next) {
							setName(team.name);
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
						if (e.key === "Escape") {
							setName(team.name);
							(e.currentTarget as HTMLInputElement).blur();
						}
					}}
					maxLength={100}
				/>
				<Stack gap={6}>
					<Text size="sm" fw={500}>
						<Trans>Logo</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>Workspace-level logo overrides the team logo when set.</Trans>
					</Text>
					{currentTeamLogoUrl ? (
						<Group gap="sm" align="center">
							<Image
								src={currentTeamLogoUrl}
								alt={t`Team logo`}
								h={48}
								w="auto"
								fit="contain"
								style={{ maxWidth: 200 }}
							/>
							<Button
								variant="subtle"
								color="red"
								size="compact-sm"
								leftSection={<IconTrash size={14} />}
								loading={removeLogoMutation.isPending}
								disabled={!canEdit}
								onClick={() => removeLogoMutation.mutate()}
							>
								<Trans>Remove</Trans>
							</Button>
						</Group>
					) : (
						<Text size="xs" c="dimmed" fs="italic">
							<Trans>No logo set — dembrane default will be used.</Trans>
						</Text>
					)}
					<FileButton
						resetRef={logoResetRef}
						onChange={handleLogoSelect}
						accept="image/png,image/jpeg,image/webp"
						disabled={!canEdit}
					>
						{(props) => (
							<Button
								variant="light"
								size="compact-sm"
								leftSection={<IconUpload size={14} />}
								loading={uploadLogoMutation.isPending}
								style={{ alignSelf: "flex-start" }}
								{...props}
							>
								{currentTeamLogoUrl ? (
									<Trans>Replace logo</Trans>
								) : (
									<Trans>Upload logo</Trans>
								)}
							</Button>
						)}
					</FileButton>
				</Stack>
			</Stack>

			{/* Count tiles dropped 2026-04-23: the team header subtitle
			    already says "N workspaces · M people", and the Usage /
			    People tabs hold the detailed views. Repeating the same
			    numbers on Overview was just noise. */}

			{/* Danger section — not wired to a self-serve delete yet
			    (no backend endpoint; ownership transfer + team delete
			    are support flows for now). Primes the audit §3 pattern
			    without offering a fake affordance. Admin only. */}
			{canEdit && (
				<Stack gap={4} mt="xl">
					<Text size="xs" fw={500} tt="uppercase" c="red.9" lts={0.5}>
						<Trans>Danger</Trans>
					</Text>
					<Text size="sm" c="dimmed">
						<Trans>
							Deleting a team is a support-assisted operation. Email{" "}
							<Anchor href="mailto:support@dembrane.com">
								support@dembrane.com
							</Anchor>{" "}
							and we'll walk through it with you — all workspaces must
							be empty and deleted first.
						</Trans>
					</Text>
				</Stack>
			)}
		</Stack>
	);
}

export default TeamRoute;
