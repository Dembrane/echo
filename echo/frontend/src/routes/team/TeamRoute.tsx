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
	Drawer,
	Group,
	Loader,
	Paper,
	SegmentedControl,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import {
	IconLock,
	IconPlus,
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

export const TeamRoute = () => {
	const { teamId } = useParams();
	const navigate = useI18nNavigate();
	const [search, setSearch] = useState("");
	const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
	const [workspacesDrawer, setWorkspacesDrawer] = useState(false);
	const [view, setView] = useState<"matrix" | "projects">("matrix");

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
					<Group gap="xs" wrap="nowrap">
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
						{isAdmin && (
							<Button
								size="sm"
								variant="default"
								onClick={() => setWorkspacesDrawer(true)}
							>
								<Trans>Manage workspaces</Trans>
							</Button>
						)}
						{isAdmin && (
							<Button
								size="sm"
								leftSection={<IconPlus size={14} />}
								onClick={() => navigate("/w/new")}
							>
								<Trans>New workspace</Trans>
							</Button>
						)}
					</Group>
				</Group>

				{/* Matrix §8 team-scope usage rollup — hours, seats, guests,
				    projects aggregated across all team workspaces + count of
				    workspaces at/approaching cap. Admin + billing see
				    aggregate € forecast. Members see raw numbers only. */}
				{teamId && <TeamUsageRollup orgId={teamId} />}

				{/* View switcher — admin-only Projects tab gives access to
				    the matrix §4 delete-workspace workflow (wind down
				    projects across workspaces from one surface). */}
				{isAdmin && (
					<SegmentedControl
						size="xs"
						value={view}
						onChange={(v) => setView(v as "matrix" | "projects")}
						data={[
							{ value: "matrix", label: t`People` },
							{ value: "projects", label: t`Projects` },
						]}
						style={{ alignSelf: "flex-start" }}
					/>
				)}

				{/* Toolbar — only shown on People view. */}
				{view === "matrix" && (
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

				{/* Projects view — admin-only. Matrix §4 delete-workspace
				    workflow: wind down projects across all team workspaces
				    from one surface. */}
				{view === "projects" && isAdmin && teamId && (
					<TeamProjectsTable orgId={teamId} />
				)}

				{/* Matrix — the main content. Sticky first column (name+email)
				    so it stays visible on horizontal scroll. Mantine Table
				    with stickyHeader + custom sticky-left on the first cell. */}
				{view === "matrix" && (
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
										<Badge
											size="sm"
											variant="light"
											color={
												m.role === "owner"
													? "blue"
													: m.role === "admin"
														? "blue"
														: "gray"
											}
											style={{ textTransform: "capitalize" }}
										>
											{m.role}
										</Badge>
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
																? t`Direct ${directRole} on this workspace`
																: t`Admin · inherited from team role`
														}
														withArrow
													>
														<Badge
															size="xs"
															variant="light"
															color={
																displayRole === "owner" ||
																displayRole === "admin"
																	? "blue"
																	: displayRole === "billing"
																		? "yellow"
																		: "gray"
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

				{view === "matrix" && (
					<Text size="xs" c="dimmed">
						<Trans>
							Team admins can join any workspace to get a direct admin seat.
							Workspace invites live in each workspace's settings.
						</Trans>
					</Text>
				)}
			</Stack>

			{/* Manage workspaces drawer — list of team workspaces with
			    inline nav. Keeps the primary canvas clean. */}
			<Drawer
				opened={workspacesDrawer}
				onClose={() => setWorkspacesDrawer(false)}
				title={<Text fw={500}>{t`Workspaces`}</Text>}
				position="right"
				padding="lg"
				size="sm"
			>
				<Stack gap="xs">
					{workspaces.map((ws) => (
						<Paper
							key={ws.id}
							p="sm"
							withBorder
							radius="md"
							style={{ cursor: "pointer" }}
							onClick={() => navigate(`/w/${ws.id}/projects`)}
						>
							<Group justify="space-between" wrap="nowrap">
								<Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
									{ws.is_private && (
										<IconLock
											size={14}
											style={{ color: "var(--mantine-color-gray-6)" }}
											aria-label={t`Private workspace`}
										/>
									)}
									<Stack gap={0} style={{ minWidth: 0 }}>
										<Text size="sm" fw={500} truncate>
											{ws.name}
											{ws.is_default && (
												<Text component="span" size="xs" c="dimmed" ml={6}>
													<Trans>(default)</Trans>
												</Text>
											)}
										</Text>
										<Text size="xs" c="dimmed">
											{ws.project_count} {t`projects`} · {ws.member_count}{" "}
											{t`members`}
										</Text>
									</Stack>
								</Group>
								<Group gap={4}>
									<TierBadge tier={ws.tier} size="sm" />
									{isAdmin && (
										<Tooltip label={t`Workspace settings`} withArrow>
											<ActionIcon
												variant="subtle"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													navigate(`/w/${ws.id}/settings`);
												}}
											>
												<IconSettings size={14} />
											</ActionIcon>
										</Tooltip>
									)}
								</Group>
							</Group>
						</Paper>
					))}
					{workspaces.length === 0 && (
						<Text size="sm" c="dimmed" ta="center" py="md">
							<Trans>No workspaces yet.</Trans>
						</Text>
					)}
				</Stack>
			</Drawer>
		</Container>
	);
};

export default TeamRoute;
