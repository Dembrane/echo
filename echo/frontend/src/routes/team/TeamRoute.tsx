import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Anchor,
	Avatar,
	Badge,
	Box,
	Button,
	Center,
	Container,
	Group,
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { useDocumentTitle } from "@mantine/hooks";
import {
	IconChevronDown,
	IconLock,
	IconSearch,
	IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { TeamProjectsTable } from "@/components/workspace/TeamProjectsTable";
import { TeamUsageRollup } from "@/components/workspace/TeamUsageRollup";
import { TierBadge } from "@/components/workspace/TierBadge";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useUrlSearch } from "@/hooks/useUrlSearch";
import { useSearchParams } from "react-router";
import { avatarUrl } from "@/lib/avatar";

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
	if (!res.ok) return [];
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
// billing (matrix §5 has team Admin/Billing/Member but we only ship
// Admin + Member team-level today; billing is workspace-scope in
// this release). Owner is only offered when caller is themselves owner.
const TEAM_ROLE_OPTIONS_ADMIN = ["member", "admin"] as const;
const TEAM_ROLE_OPTIONS_OWNER = ["member", "admin", "owner"] as const;

const WS_ROLE_OPTIONS_ADMIN = ["member", "billing", "admin"] as const;
const WS_ROLE_OPTIONS_OWNER = ["member", "billing", "admin", "owner"] as const;

function roleColor(role: string): string {
	if (role === "owner" || role === "admin") return "blue";
	if (role === "billing") return "yellow";
	return "gray";
}

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
			<Badge
				size={size}
				variant="light"
				color={roleColor(currentRole)}
				style={{ textTransform: "capitalize" }}
			>
				{currentRole}
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
					style={{ textTransform: "capitalize", cursor: "pointer" }}
					rightSection={<IconChevronDown size={10} />}
				>
					{currentRole}
				</Badge>
			</Menu.Target>
			<Menu.Dropdown>
				{options.map((role) => (
					<Menu.Item
						key={role}
						disabled={role === currentRole}
						onClick={() => onChange(role)}
						style={{ textTransform: "capitalize" }}
					>
						{role}
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
	const { teamId } = useParams();
	const navigate = useI18nNavigate();
	const [search, setSearch] = useUrlSearch();
	const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
	const queryClient = useQueryClient();
	const [searchParams, setSearchParams] = useSearchParams();
	// URL-driven tab state. Admin-only tabs fall back to people for
	// everyone else (guard below). Default lands on overview — the
	// "what is this team" answer.
	const tabParam = searchParams.get("tab");
	const allowedTabs = ["overview", "usage", "people"] as const;
	type TabValue = (typeof allowedTabs)[number];
	const viewRaw: TabValue =
		tabParam && (allowedTabs as readonly string[]).includes(tabParam)
			? (tabParam as TabValue)
			: "overview";
	const setView = (value: string | null) => {
		if (!value) return;
		const next = new URLSearchParams(searchParams);
		next.set("tab", value);
		setSearchParams(next, { replace: true });
	};

	useDocumentTitle(t`Team | dembrane`);

	const { data: team, isLoading: teamLoading } = useQuery({
		queryKey: ["v2", "team", teamId],
		queryFn: () => fetchTeam(teamId as string),
		enabled: Boolean(teamId),
		staleTime: 30_000,
	});
	const { data: members = [] } = useQuery({
		queryKey: ["v2", "team", teamId, "members"],
		queryFn: () => fetchTeamMembers(teamId as string),
		enabled: Boolean(teamId),
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
							<Avatar src={team.logo_url} size={40} radius="md" />
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
					{/* Header is read-only now — actions live inside the view
					    switcher below. "New workspace" button moved off this
					    page (home selector owns that affordance). */}
					{isAdmin && (
						<Tooltip label={t`Team settings`} withArrow>
							<ActionIcon
								variant="default"
								size="lg"
								onClick={() => navigate(`/t/${teamId}/settings`)}
							>
								<IconSettings size={16} />
							</ActionIcon>
						</Tooltip>
					)}
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
					</Tabs.List>

					<Tabs.Panel value="overview" pt="md">
						<OverviewPanel
							team={team}
							teamId={teamId!}
							canEdit={isAdmin}
							workspaceCount={workspaces.length}
							memberCount={members.length}
							queryClient={queryClient}
						/>
					</Tabs.Panel>

					{isAdmin && (
						<Tabs.Panel value="usage" pt="md">
							<Stack gap="md">
								{teamId && <TeamUsageRollup orgId={teamId} />}
								{teamId && <TeamProjectsTable orgId={teamId} />}
							</Stack>
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
						<Text size="xs" c="dimmed">
							<Trans>
								Showing {filteredMembers.length} of {members.length}
							</Trans>
						</Text>
					</Group>
				)}

				{/* Matrix — the main content. Sticky first column (name+email)
				    so it stays visible on horizontal scroll. Mantine Table
				    with stickyHeader + custom sticky-left on the first cell. */}
				{true && (
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
												{ws.project_count} {t`projects`}
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
											options={
												isOwner
													? TEAM_ROLE_OPTIONS_OWNER
													: TEAM_ROLE_OPTIONS_ADMIN
											}
											disabled={!isAdmin}
											onChange={(next) =>
												teamRoleMutation.mutate({
													userId: m.user_id,
													role: next,
												})
											}
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
										const displayRole = directRole
											? directRole
											: derivedAdmin
												? "admin"
												: null;
										return (
											<Table.Td
												key={`${m.user_id}-${ws.id}`}
												style={{ textAlign: "center" }}
											>
												{displayRole ? (
													<Tooltip
														label={
															directRole
																? t`${directRole} on this workspace · change in workspace settings`
																: t`Admin here (from team role)`
														}
														withArrow
													>
														<Badge
															size="xs"
															variant="light"
															color={roleColor(displayRole)}
															style={{
																cursor: directRole ? "pointer" : undefined,
																textTransform: "capitalize",
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
															{displayRole}
														</Badge>
													</Tooltip>
												) : ws.is_private && m.role === "admin" ? (
													<Tooltip
														label={t`Private workspace — ask the workspace owner for an invite`}
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
	body: { name?: string; logo_url?: string | null },
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

function OverviewPanel({
	team,
	teamId,
	canEdit,
	workspaceCount,
	memberCount,
	queryClient,
}: {
	team: TeamDetail;
	teamId: string;
	canEdit: boolean;
	workspaceCount: number;
	memberCount: number;
	queryClient: ReturnType<typeof useQueryClient>;
}) {
	const [name, setName] = useState<string | null>(null);
	const [logoUrl, setLogoUrl] = useState<string | null>(null);

	const effectiveName = name ?? team.name;
	const effectiveLogo = logoUrl ?? team.logo_url ?? "";
	const dirty =
		(name !== null && name.trim() !== team.name) ||
		(logoUrl !== null && logoUrl.trim() !== (team.logo_url ?? ""));

	const saveMutation = useMutation({
		mutationFn: (body: { name?: string; logo_url?: string | null }) =>
			updateTeamFromOverview(teamId, body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "team", teamId] });
			queryClient.invalidateQueries({ queryKey: ["v2", "orgs"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			toast.success(t`Saved`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	return (
		<Stack gap="lg">
			{/* Team identity — name + logo. Admins edit inline; others read. */}
			<Stack gap="md">
				<TextInput
					label={t`Team name`}
					description={t`Shown on the workspace selector and in email subject lines.`}
					value={effectiveName}
					disabled={!canEdit}
					onChange={(e) => setName(e.currentTarget.value)}
					maxLength={100}
				/>
				<TextInput
					label={t`Logo URL`}
					description={t`Absolute https URL. Workspace-level logo overrides when set.`}
					placeholder="https://..."
					value={effectiveLogo}
					disabled={!canEdit}
					onChange={(e) => setLogoUrl(e.currentTarget.value)}
					maxLength={2048}
				/>
				{canEdit && (
					<Group justify="flex-end">
						<Button
							variant="default"
							onClick={() => {
								setName(null);
								setLogoUrl(null);
							}}
							disabled={!dirty}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							loading={saveMutation.isPending}
							disabled={!dirty}
							onClick={() => {
								const payload: {
									name?: string;
									logo_url?: string | null;
								} = {};
								if (name !== null && name.trim() !== team.name) {
									payload.name = name.trim();
								}
								if (
									logoUrl !== null &&
									logoUrl.trim() !== (team.logo_url ?? "")
								) {
									payload.logo_url = logoUrl.trim() || null;
								}
								saveMutation.mutate(payload);
							}}
						>
							<Trans>Save</Trans>
						</Button>
					</Group>
				)}
			</Stack>

			{/* At-a-glance counts. Keep light — the detailed views are one
			    tab over. */}
			<Group gap="xl">
				<Stack gap={0}>
					<Text size="lg" fw={500}>{workspaceCount}</Text>
					<Text size="xs" c="dimmed">
						<Trans>workspaces</Trans>
					</Text>
				</Stack>
				<Stack gap={0}>
					<Text size="lg" fw={500}>{memberCount}</Text>
					<Text size="xs" c="dimmed">
						<Trans>people</Trans>
					</Text>
				</Stack>
			</Group>
		</Stack>
	);
}

export default TeamRoute;
