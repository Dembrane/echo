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
	IconChevronRight,
	IconLock,
	IconPlus,
	IconSettings,
	IconTrash,
	IconUpload,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { InviteMemberCard, MembersToolbar } from "@/components/members";
import { TeamInviteWizard } from "@/components/team/TeamInviteWizard";
import { TeamUsageRollup } from "@/components/workspace/TeamUsageRollup";
import { TierBadge } from "@/components/workspace/TierBadge";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useUrlSearch } from "@/hooks/useUrlSearch";
import { useV2Me } from "@/hooks/useV2Me";
import { avatarUrl, logoUrl as resolveLogoUrl, memberInitials } from "@/lib/avatar";
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
	// True when the person is only reachable via external workspace
	// memberships — no org_membership. Admins see them in the team
	// Members list with a Guest badge; no team-role picker is shown.
	is_external?: boolean;
	// workspace_id → role for direct memberships (not derived).
	direct_workspace_roles?: Record<string, string>;
	// workspace_id → membership_id for direct rows — enables in-row
	// role changes without a second lookup.
	direct_workspace_membership_ids?: Record<string, string>;
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

type RoleFilter = "all" | "admins" | "members" | "guests";

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
	const [inviteOpen, setInviteOpen] = useState(false);
	const queryClient = useQueryClient();
	// URL-driven tab state. Tab lives in the path segment
	// (`/t/:teamId/<tab>`) so browser back steps between tabs and URLs
	// are shareable.
	const allowedTabs = ["overview", "usage", "people"] as const;
	type TabValue = (typeof allowedTabs)[number];
	const segment = (splat ?? "").split("/")[0] || "";
	const viewRaw: TabValue = (allowedTabs as readonly string[]).includes(segment)
		? (segment as TabValue)
		: "overview";

	useEffect(() => {
		// Bounce bare /t/:id to /t/:id/overview so the URL always
		// matches the active tab.
		if (!teamId) return;
		if (segment !== viewRaw) {
			navigate(`/t/${teamId}/${viewRaw}`, { replace: true });
		}
	}, [teamId, viewRaw, segment, navigate]);

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

	// Per-workspace role change triggered from the team People tab's
	// expanded card. Works on direct memberships (backend returns the
	// membership id alongside the role). Invalidates both the team
	// members query and the target workspace's settings query so any
	// open surface reflects the new role.
	const workspaceRoleMutation = useMutation({
		mutationFn: ({
			workspaceId,
			membershipId,
			role,
		}: {
			workspaceId: string;
			membershipId: string;
			role: string;
		}) => changeWorkspaceMemberRole(workspaceId, membershipId, role),
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "team", teamId, "members"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "workspace-settings", variables.workspaceId],
			});
			toast.success(t`Role changed`);
		},
		onError: (e: Error) => toast.error(e.message),
	});

	const removeTeamMemberMutation = useMutation({
		mutationFn: async ({ userId }: { userId: string }) => {
			if (!teamId) throw new Error("No team");
			const res = await fetch(
				`${API_BASE_URL}/v2/orgs/${teamId}/members/${userId}`,
				{ method: "DELETE", credentials: "include" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(
					typeof data.detail === "string"
						? data.detail
						: "Couldn't remove member",
				);
			}
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "team", teamId, "members"],
			});
			toast.success(t`Removed from team`);
		},
		onError: (e: Error) => toast.error(e.message),
	});

	// Add-to-workspace from the Team Members tab. Reuses the workspace
	// invite endpoint — the target is an existing team member, so the
	// server treats it as a direct workspace grant rather than an email
	// invite (is_org_member=true).
	const addToWorkspaceMutation = useMutation({
		mutationFn: async ({
			workspaceId,
			email,
			role,
		}: {
			workspaceId: string;
			email: string;
			role: string;
		}) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
				{
					body: JSON.stringify({ email, role, is_org_member: true }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(
					typeof data.detail === "string"
						? data.detail
						: "Couldn't add to workspace",
				);
			}
			return res.json();
		},
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "team", teamId, "members"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "workspace-settings", variables.workspaceId],
			});
			toast.success(t`Added to workspace`);
		},
		onError: (e: Error) => toast.error(e.message),
	});

	const { data: meV2 } = useV2Me();
	const myAppUserId = meV2?.id ?? null;

	const hasGuests = useMemo(
		() => members.some((m) => m.is_external),
		[members],
	);

	const filteredMembers = useMemo(() => {
		const q = search.trim().toLowerCase();
		return members.filter((m) => {
			// Matrix §5: internal team roles are Admin / Billing / Member.
			// Externals show up as a fourth bucket ("guests") — they have
			// no org_membership, only per-workspace external rows. The
			// admins/members filters exclude externals; "guests" isolates
			// them. Filter collapses owner → admin for display.
			if (roleFilter === "admins") {
				if (m.is_external) return false;
				if (!(m.role === "owner" || m.role === "admin")) return false;
			}
			if (roleFilter === "members") {
				if (m.is_external) return false;
				if (m.role !== "member") return false;
			}
			if (roleFilter === "guests" && !m.is_external) return false;
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
					<Group gap="md" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
						{team.logo_url && (
							<Image
								src={resolveLogoUrl(team.logo_url)}
								alt={t`${team.name} logo`}
								h={48}
								w="auto"
								fit="contain"
								style={{ maxWidth: 160, flexShrink: 0 }}
							/>
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
								<Trans>Usage and Tier</Trans>
							</Tabs.Tab>
						)}
						<Tabs.Tab value="people">
							<Trans>Members</Trans>
						</Tabs.Tab>
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

					<Tabs.Panel value="people" pt="md">
						<Stack gap="md">
				<MembersToolbar
					search={search}
					onSearchChange={setSearch}
					filter={{
						value: roleFilter,
						onChange: (v) => setRoleFilter(v as RoleFilter),
						options: [
							{ value: "all", label: t`All` },
							{ value: "admins", label: t`Admins` },
							{ value: "members", label: t`Members` },
							...(hasGuests
								? [{ value: "guests", label: t`Guests` }]
								: []),
						],
					}}
					count={{ shown: filteredMembers.length, total: members.length }}
					error={
						membersError
							? t`Couldn't load team members. Try refreshing, and if it keeps failing, contact support.`
							: null
					}
				/>

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

				{/* Members list: dotted invite card as the first row (same
				    shape as any other member), then one TeamPersonCard per
				    person. Externals render inline with a Guest badge so
				    admins see everyone reaching their data in one list. */}
				{!membersError && (
					<Stack gap="xs">
						{isAdmin && workspaces.length > 0 && (
							<InviteMemberCard
								label={<Trans>Invite someone</Trans>}
								helperText={
									<Trans>Pick one or more workspaces and we'll send the email.</Trans>
								}
								onClick={() => setInviteOpen(true)}
							/>
						)}
						{members.length === 0 && (
							<Stack align="center" gap={6} py={48}>
								<Title order={4} fw={400}>
									<Trans>No one on the team yet.</Trans>
								</Title>
								<Text size="sm" c="dimmed" ta="center" maw={400}>
									<Trans>
										Team members appear here once they join a workspace.
									</Trans>
								</Text>
							</Stack>
						)}
						{filteredMembers.map((m) => (
							<TeamPersonCard
								key={m.user_id}
								member={m}
								workspaces={workspaces}
								isAdmin={isAdmin}
								isSelf={m.app_user_id === myAppUserId}
								onTeamRoleChange={(next) =>
									teamRoleMutation.mutate({
										userId: m.user_id,
										role: next,
									})
								}
								onWorkspaceRoleChange={(ws, membershipId, next) =>
									workspaceRoleMutation.mutate({
										workspaceId: ws,
										membershipId,
										role: next,
									})
								}
								onAddToWorkspace={(ws, role) =>
									addToWorkspaceMutation.mutate({
										workspaceId: ws,
										email: m.email,
										role,
									})
								}
								onRemove={() =>
									removeTeamMemberMutation.mutate({ userId: m.user_id })
								}
							/>
						))}
						{members.length > 0 && filteredMembers.length === 0 && (
							<Text size="sm" c="dimmed" ta="center" py="md">
								<Trans>No one matches that filter.</Trans>
							</Text>
						)}
					</Stack>
				)}
				{teamId && (
					<TeamInviteWizard
						opened={inviteOpen}
						onClose={() => setInviteOpen(false)}
						workspaces={workspaces}
						members={members}
					/>
				)}

				<Text size="xs" c="dimmed">
					<Trans>
						Admins can reach every workspace in this team. Members and
						guests only see the workspaces they've been given access to.
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
								h={72}
								w="auto"
								fit="contain"
								style={{ maxWidth: 320 }}
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
							<Trans>No logo set. dembrane default will be used.</Trans>
						</Text>
					)}
					{/* No single-click "Replace" — destructive step is explicit. */}
					{!currentTeamLogoUrl && (
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
									<Trans>Upload logo</Trans>
								</Button>
							)}
						</FileButton>
					)}
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

/**
 * One row on the team People tab. Summarizes a person's team role +
 * their per-workspace access, expands to let an admin change
 * per-workspace roles or remove the person from the team.
 *
 * Role changes go through a confirm modal (never silent). Uniform
 * per-workspace role shows as a single "Admin across all" pill
 * instead of listing each workspace — common case, less noise.
 */
function TeamPersonCard({
	member,
	workspaces,
	isAdmin,
	isSelf,
	onTeamRoleChange,
	onWorkspaceRoleChange,
	onAddToWorkspace,
	onRemove,
}: {
	member: TeamMember;
	workspaces: TeamWorkspace[];
	isAdmin: boolean;
	isSelf: boolean;
	onTeamRoleChange: (next: string) => void;
	onWorkspaceRoleChange: (
		workspaceId: string,
		membershipId: string,
		next: string,
	) => void;
	onAddToWorkspace: (workspaceId: string, role: string) => void;
	onRemove: () => void;
}) {
	const [open, setOpen] = useState(false);

	// Workspace access summary — direct role wins; derivation fills in
	// for admin/owner rows on non-private workspaces. Matches the old
	// matrix rules so the upgrade doesn't hide access state.
	const perWorkspace = useMemo(() => {
		return workspaces.map((ws) => {
			const directRole = member.direct_workspace_roles?.[ws.id];
			const membershipId = member.direct_workspace_membership_ids?.[ws.id];
			const derivedAdmin =
				!directRole &&
				(member.role === "owner" ||
					(member.role === "admin" && !ws.is_private));
			const role: string | null = directRole
				? directRole
				: derivedAdmin
					? "admin"
					: null;
			return {
				ws,
				role,
				isDirect: Boolean(directRole),
				membershipId: membershipId ?? null,
			};
		});
	}, [workspaces, member.direct_workspace_roles, member.direct_workspace_membership_ids, member.role]);

	// Summary line: "Admin across all" when uniform, otherwise a short
	// breakdown. Ignore workspaces they don't appear on at all.
	const reached = perWorkspace.filter((w) => w.role !== null);
	const summary = useMemo(() => {
		if (reached.length === 0) return t`No workspace access yet`;
		const roleSet = new Set(reached.map((w) => w.role as string));
		if (reached.length === workspaces.length && roleSet.size === 1) {
			return t`${displayRole(reached[0].role as string)} across all`;
		}
		// Mixed state — "Admin on 3 · Member on 2"
		const counts = new Map<string, number>();
		for (const w of reached) {
			const key = w.role as string;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.map(([r, n]) => `${displayRole(r)} on ${n}`)
			.join(" · ");
	}, [reached, workspaces.length]);

	const handleTeamRoleChange = (next: string) => {
		const person = member.display_name || member.email || t`this person`;
		modals.openConfirmModal({
			title: t`Change team role?`,
			children: (
				<Text size="sm">
					<Trans>
						Change {person}'s team role from{" "}
						<em>{displayRole(member.role)}</em> to{" "}
						<em>{displayRole(next)}</em>?
					</Trans>
				</Text>
			),
			labels: { confirm: t`Change role`, cancel: t`Cancel` },
			onConfirm: () => onTeamRoleChange(next),
		});
	};

	const handleWorkspaceRoleChange = (
		wsId: string,
		wsName: string,
		membershipId: string,
		currentRole: string,
		next: string,
	) => {
		const person = member.display_name || member.email || t`this person`;
		modals.openConfirmModal({
			title: t`Change workspace role?`,
			children: (
				<Text size="sm">
					<Trans>
						Change {person}'s role on {wsName} from{" "}
						<em>{displayRole(currentRole)}</em> to{" "}
						<em>{displayRole(next)}</em>?
					</Trans>
				</Text>
			),
			labels: { confirm: t`Change role`, cancel: t`Cancel` },
			onConfirm: () => onWorkspaceRoleChange(wsId, membershipId, next),
		});
	};

	const handleRemove = () => {
		const person = member.display_name || member.email || t`this person`;
		modals.openConfirmModal({
			title: t`Remove from team?`,
			children: (
				<Stack gap={8}>
					<Text size="sm">
						<Trans>
							{person} will lose access to every workspace in this
							team. Direct-only workspace invites stay intact.
						</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							You can re-invite them later from any workspace.
						</Trans>
					</Text>
				</Stack>
			),
			labels: { confirm: t`Remove`, cancel: t`Cancel` },
			confirmProps: { color: "red" },
			onConfirm: onRemove,
		});
	};

	return (
		<Paper withBorder radius="md" p="md">
			<Stack gap={open ? 12 : 0}>
				<Group justify="space-between" wrap="nowrap" gap="md">
					<Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
						<Avatar src={avatarUrl(member.avatar, 64)} size="md" radius="xl">
							{memberInitials(member.display_name, member.email)}
						</Avatar>
						<Stack gap={0} style={{ minWidth: 0 }}>
							<Text size="sm" fw={500} truncate>
								{member.display_name || member.email || t`Unknown member`}
							</Text>
							{member.email &&
								member.email !== member.display_name && (
									<Text size="xs" c="dimmed" truncate>
										{member.email}
									</Text>
								)}
							<Text size="xs" c="dimmed" mt={4}>
								{summary}
							</Text>
						</Stack>
					</Group>
					<Group gap="xs" wrap="nowrap">
						{member.is_external ? (
							<Tooltip label={t`No team role. Access via workspace invites.`}>
								<Badge size="sm" variant="light" color="gray">
									<Trans>Guest</Trans>
								</Badge>
							</Tooltip>
						) : (
							<RoleBadgeMenu
								currentRole={member.role}
								options={TEAM_ROLE_OPTIONS}
								disabled={!isAdmin || isSelf}
								onChange={handleTeamRoleChange}
							/>
						)}
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							onClick={() => setOpen((v) => !v)}
							aria-label={open ? t`Hide detail` : t`Show detail`}
						>
							{open ? (
								<IconChevronDown size={14} />
							) : (
								<IconChevronRight size={14} />
							)}
						</ActionIcon>
					</Group>
				</Group>

				{open && (
					<Stack gap={12} pl={56}>
						<Text size="xs" fw={500} tt="uppercase" c="dimmed" lts={0.5}>
							<Trans>Per-workspace access</Trans>
						</Text>
						<Stack gap={6}>
							{perWorkspace.map(({ ws, role, isDirect, membershipId }) => (
								<Group
									key={ws.id}
									justify="space-between"
									wrap="nowrap"
									gap="sm"
								>
									<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
										{ws.is_private && (
											<IconLock
												size={12}
												color="var(--mantine-color-gray-6)"
											/>
										)}
										<Text size="sm" truncate>
											{ws.name}
										</Text>
									</Group>
									{role ? (
										isAdmin && isDirect && membershipId ? (
											<RoleBadgeMenu
												currentRole={role}
												options={WS_ROLE_OPTIONS}
												size="xs"
												onChange={(next) =>
													handleWorkspaceRoleChange(
														ws.id,
														ws.name,
														membershipId,
														role,
														next,
													)
												}
											/>
										) : (
											<Tooltip
												label={
													isDirect
														? t`Change in workspace settings`
														: t`Admin here via team role`
												}
											>
												<Badge
													size="xs"
													variant="light"
													color={roleColor(role)}
												>
													{displayRole(role)}
												</Badge>
											</Tooltip>
										)
									) : isAdmin && member.email ? (
										// Admin can add this person to a workspace they
										// don't currently have a role on. Reuses the
										// workspace invite endpoint (is_org_member=true)
										// so the server sees this as a direct grant,
										// not a fresh invitation.
										<Button
											size="compact-xs"
											variant="subtle"
											leftSection={<IconPlus size={12} />}
											onClick={() => {
												const nextRole = member.is_external
													? "guest"
													: "member";
												modals.openConfirmModal({
													title: t`Add to ${ws.name}?`,
													children: (
														<Text size="sm">
															<Trans>
																Add{" "}
																{member.display_name ||
																	member.email ||
																	t`this person`}{" "}
																to {ws.name} as{" "}
																<em>{displayRole(nextRole)}</em>?
															</Trans>
														</Text>
													),
													labels: {
														confirm: t`Add`,
														cancel: t`Cancel`,
													},
													onConfirm: () =>
														onAddToWorkspace(ws.id, nextRole),
												});
											}}
										>
											<Trans>Add</Trans>
										</Button>
									) : ws.is_private ? (
										<Text size="xs" c="dimmed">
											<Trans>No access</Trans>
										</Text>
									) : (
										<Text size="xs" c="dimmed">
											—
										</Text>
									)}
								</Group>
							))}
						</Stack>
						{isAdmin && !isSelf && (
							<Group justify="flex-end" mt={4}>
								<Button
									size="compact-xs"
									variant="subtle"
									color="red"
									onClick={handleRemove}
								>
									<Trans>Remove from team</Trans>
								</Button>
							</Group>
						)}
					</Stack>
				)}
			</Stack>
		</Paper>
	);
}
