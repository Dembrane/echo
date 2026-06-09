import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Anchor,
	Avatar,
	Badge,
	Box,
	Button,
	Center,
	Container,
	Group,
	Image,
	Loader,
	Menu,
	Paper,
	SimpleGrid,
	Stack,
	Tabs,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
	IconChevronDown,
	IconChevronRight,
	IconClock,
	IconLock,
	IconPlus,
	IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { toast } from "@/components/common/Toaster";
import { InviteModal } from "@/components/invite/InviteModal";
import {
	InviteMemberCard,
	MembersToolbar,
	PendingInvitesSection,
} from "@/components/members";
import { OrganisationCapBanner } from "@/components/organisation/OrganisationCapBanner";
import { DiscoverableWorkspaces } from "@/components/workspace/DiscoverableWorkspaces";
import { OrganisationUsageRollup } from "@/components/workspace/OrganisationUsageRollup";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useUrlSearch } from "@/hooks/useUrlSearch";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import {
	avatarUrl,
	memberInitials,
	logoUrl as resolveLogoUrl,
} from "@/lib/avatar";
import { displayRole, roleColor } from "@/lib/roles";
import { OrganisationExternalView } from "./OrganisationExternalView";

/**
 * Organisation admin page — single-page matrix view.
 *
 * Design call (2026-04-21): collapse the previous 3-tab layout (Members /
 * Matrix / Workspaces) into one canvas with the matrix as primary content.
 * The matrix rows already ARE the member list; the columns are the
 * workspaces. A secondary Drawer houses workspace management; everything
 * else is inline.
 */

interface OrganisationDetail {
	id: string;
	name: string;
	description: string | null;
	logo_url: string | null;
	role: string;
	member_count: number;
	workspace_count: number;
	external_count: number;
}

interface WorkspaceMemberPreview {
	display_name: string;
	avatar: string | null;
}

interface WorkspacePinnedProject {
	id: string;
	name: string;
}

interface OrganisationMember {
	user_id: string;
	app_user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	role: string;
	accessible_workspace_count: number;
	is_pending: boolean;
	// True when the person is only reachable via external workspace
	// memberships — no org_membership. Admins see them in the organisation
	// Members list with an External badge; no organisation-role picker is shown.
	is_external?: boolean;
	// workspace_id → role for direct memberships (not derived).
	direct_workspace_roles?: Record<string, string>;
	// workspace_id → membership_id for direct rows — enables in-row
	// role changes without a second lookup.
	direct_workspace_membership_ids?: Record<string, string>;
}

interface OrganisationWorkspace {
	id: string;
	name: string;
	tier: string;
	is_default: boolean;
	project_count: number;
	member_count: number;
	is_private: boolean;
	seat_invite_blocked?: boolean;
	// Top pinned projects per workspace — backend-enriched on
	// GET /v2/orgs/:id/workspaces. Merged into the access-scoped overview cards.
	pinned_projects?: WorkspacePinnedProject[];
}

async function fetchOrganisation(
	organisationId: string,
): Promise<OrganisationDetail | null> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${organisationId}`, {
		credentials: "include",
	});
	// 401/403/404 → null feeds the "not found" UI; other failures must throw so 5xx isn't masked as 404.
	if (res.status === 401 || res.status === 403 || res.status === 404) {
		return null;
	}
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: t`Couldn't load organisation (${res.status})`,
		);
	}
	return res.json();
}

async function fetchOrganisationMembers(
	organisationId: string,
): Promise<OrganisationMember[] | null> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${organisationId}/members`, {
		credentials: "include",
	});
	// Auth-style failures are not crashes — they're "you don't have
	// access here". Return null so callers can show an external state. 5xx
	// still throws (preserves the 2026-04-23 audit fix where a swallowed
	// 500 was masquerading as an empty organisation).
	if (res.status === 401 || res.status === 403 || res.status === 404) {
		return null;
	}
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: `Members request failed (${res.status})`,
		);
	}
	return res.json();
}

async function fetchOrganisationWorkspaces(
	organisationId: string,
): Promise<OrganisationWorkspace[] | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/orgs/${organisationId}/workspaces`,
		{
			credentials: "include",
		},
	);
	// Same convention as fetchOrganisation / fetchOrganisationMembers:
	// auth failures return null (= external-only signal), 5xx throws.
	if (res.status === 401 || res.status === 403 || res.status === 404) {
		return null;
	}
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: `Workspaces request failed (${res.status})`,
		);
	}
	return res.json();
}

type RoleFilter = "all" | "admins" | "billing" | "members" | "externals";

// Role options by scope + caller role. Organisation-level doesn't include
// Matrix §5 retires "owner" as a user-facing role — it's a backend-only
// distinction kept for last-admin protection + ownership transfer
// mechanics. The UI offers only Admin and Member (+ Billing on
// workspaces), and any "owner" record displays as "Admin" through
// displayRole(). Ownership transfer is a separate staff/support flow,
// not a role picker.
const ORGANISATION_ROLE_OPTIONS = ["member", "admin"] as const;
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

async function changeOrganisationRole(
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

export const OrganisationRoute = () => {
	const { organisationId, "*": splat } = useParams<{
		organisationId: string;
		"*": string;
	}>();
	const navigate = useI18nNavigate();
	const { search: urlSearch } = useLocation();
	const [search, setSearch] = useUrlSearch();
	const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
	const [inviteOpen, setInviteOpen] = useState(false);
	const queryClient = useQueryClient();
	// URL-driven tab state. Tab lives in the path segment
	// (`/o/:organisationId/<tab>`) so browser back steps between tabs and URLs
	// are shareable. We ALSO recognise sidebar-driven URLs:
	//   /o/:id/settings/<section>  → maps to an existing tab
	// The sidebar pushes those URLs so its view resolver lands on
	// "org-settings" while the content panel keeps using existing tabs.
	const allowedTabs = ["overview", "usage", "people", "billing"] as const;
	type TabValue = (typeof allowedTabs)[number];
	const segments = (splat ?? "").split("/").filter(Boolean);
	const segment = segments[0] ?? "";

	const isSettingsPath = segment === "settings";

	const viewRaw: TabValue = isSettingsPath
		? (() => {
				const section = segments[1] ?? "general";
				if (section === "usage") return "usage";
				if (section === "members") return "people";
				if (section === "billing") return "billing";
				// general / anything else → overview (general settings).
				return "overview";
			})()
		: (allowedTabs as readonly string[]).includes(segment)
			? (segment as TabValue)
			: "overview";

	useEffect(() => {
		// Bounce bare /o/:id to /o/:id/overview. Don't bounce /settings/*; those are canonical sidebar URLs.
		if (!organisationId) return;
		if (isSettingsPath) return;
		if (segment !== viewRaw) {
			navigate(`/o/${organisationId}/${viewRaw}${urlSearch}`, {
				replace: true,
			});
		}
	}, [organisationId, viewRaw, segment, isSettingsPath, navigate, urlSearch]);

	const setView = (value: string | null) => {
		if (!value || !organisationId) return;
		navigate(`/o/${organisationId}/${value}${urlSearch}`, { replace: true });
	};

	useDocumentTitle(t`Organisation | dembrane`);

	const {
		data: organisation,
		isLoading: organisationLoading,
		error: organisationError,
	} = useQuery({
		enabled: Boolean(organisationId),
		queryFn: () => fetchOrganisation(organisationId as string),
		queryKey: ["v2", "organisation", organisationId],
		staleTime: 30_000,
	});
	const { data: membersData, error: membersError } = useQuery({
		enabled: Boolean(organisationId),
		queryFn: () => fetchOrganisationMembers(organisationId as string),
		queryKey: ["v2", "organisation", organisationId, "members"],
		retry: 1,
	});
	const members: OrganisationMember[] = membersData ?? [];
	const { data: workspacesData, error: workspacesError } = useQuery({
		enabled: Boolean(organisationId),
		queryFn: () => fetchOrganisationWorkspaces(organisationId as string),
		queryKey: ["v2", "organisation", organisationId, "workspaces"],
		retry: false,
	});
	const workspaces: OrganisationWorkspace[] = workspacesData ?? [];
	// The current user's full workspace list (provided by the app-level
	// WorkspaceProvider). Used to detect external-only mode when the
	// org-level fetches 403.
	const { workspaces: userWorkspaces } = useWorkspace();

	const isAdmin =
		organisation?.role === "owner" || organisation?.role === "admin";
	// Financial visibility mirrors the backend's `sees_financials`
	// (orgs.py get_org_usage): owner/admin/billing. Billing is a
	// finance-only role, so it must reach Usage + Billing even though it
	// isn't an admin.
	const canSeeFinancials = isAdmin || organisation?.role === "billing";
	// Views the caller can't open fall back to People so landing state is
	// never an empty panel for them.
	const view: TabValue =
		!canSeeFinancials && (viewRaw === "usage" || viewRaw === "billing")
			? "people"
			: viewRaw;

	// Organisation-level role change — admin + owner can edit; owner-only offers
	// the "owner" option (only owners can grant owner).
	const organisationRoleMutation = useMutation({
		mutationFn: ({ userId, role }: { userId: string; role: string }) => {
			if (!organisationId) throw new Error("No organisation");
			return changeOrganisationRole(organisationId, userId, role);
		},
		onError: (e: Error) => toast.error(e.message),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "organisation", organisationId, "members"],
			});
			toast.success(t`Role changed`);
		},
	});

	// Per-workspace role change triggered from the organisation People tab's
	// expanded card. Works on direct memberships (backend returns the
	// membership id alongside the role). Invalidates both the organisation
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
		onError: (e: Error) => toast.error(e.message),
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "organisation", organisationId, "members"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "workspace-settings", variables.workspaceId],
			});
			toast.success(t`Role changed`);
		},
	});

	const removeOrganisationMemberMutation = useMutation({
		mutationFn: async ({ userId }: { userId: string }) => {
			if (!organisationId) throw new Error("No organisation");
			const res = await fetch(
				`${API_BASE_URL}/v2/orgs/${organisationId}/members/${userId}`,
				{ credentials: "include", method: "DELETE" },
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
		onError: (e: Error) => toast.error(e.message),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "organisation", organisationId, "members"],
			});
			toast.success(t`Removed from organisation`);
		},
	});

	// Add-to-workspace from the Organisation Members tab. Reuses the workspace
	// invite endpoint — the target is an existing organisation member, so
	// posting role='member' (or admin/billing) writes the workspace_membership
	// directly. The invariant (ADR-0003) ensures the org_membership stays
	// in sync.
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
					body: JSON.stringify({ email, role }),
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
		onError: (e: Error) => toast.error(e.message),
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "organisation", organisationId, "members"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "workspace-settings", variables.workspaceId],
			});
			toast.success(t`Added to workspace`);
		},
	});

	const { data: meV2 } = useV2Me();
	const myAppUserId = meV2?.id ?? null;

	const hasExternals = useMemo(
		() => members.some((m) => m.is_external),
		[members],
	);

	// Org picker only offers admin/member but rows can still hold "billing"
	// via legacy/future flows — show the chip only when ≥1 such row exists.
	const hasBilling = useMemo(
		() => members.some((m) => !m.is_external && m.role === "billing"),
		[members],
	);

	const filteredMembers = useMemo(() => {
		const q = search.trim().toLowerCase();
		return members.filter((m) => {
			// Matrix §5: internal organisation roles are Admin / Billing / Member.
			// Externals show up as a fourth bucket ("externals") — they have
			// no org_membership, only per-workspace external rows. The
			// admins/members filters exclude externals; "externals" isolates
			// them. Filter collapses owner → admin for display.
			if (roleFilter === "admins") {
				if (m.is_external) return false;
				if (!(m.role === "owner" || m.role === "admin")) return false;
			}
			if (roleFilter === "members") {
				if (m.is_external) return false;
				if (m.role !== "member") return false;
			}
			if (roleFilter === "billing") {
				if (m.is_external) return false;
				if (m.role !== "billing") return false;
			}
			if (roleFilter === "externals" && !m.is_external) return false;
			if (!q) return true;
			return (
				(m.display_name || "").toLowerCase().includes(q) ||
				(m.email || "").toLowerCase().includes(q)
			);
		});
	}, [members, search, roleFilter]);

	if (organisationLoading) {
		return (
			<Center style={{ height: "60vh" }}>
				<Loader size="sm" color="gray" />
			</Center>
		);
	}

	// Distinct from the "not found" branch below — a 5xx is not a 404.
	if (organisationError) {
		return (
			<FetchErrorPanel
				onRetry={() =>
					queryClient.invalidateQueries({
						queryKey: ["v2", "organisation", organisationId],
					})
				}
				detail={
					organisationError instanceof Error ? organisationError.message : null
				}
				message={
					<Trans>
						We couldn't load this organisation. Try again in a moment.
					</Trans>
				}
				secondaryAction={{
					label: <Trans>Back</Trans>,
					onClick: () => navigate("/o"),
				}}
			/>
		);
	}

	if (!organisation) {
		// 401/403/404 fall through here. If the user has an external
		// workspace in this org, render the external landing instead of the
		// generic "not found" — they're not lost, they're just not an
		// org admin.
		const externalWorkspaces = userWorkspaces.filter(
			(w) => w.org_id === organisationId && w.role === "external",
		);
		if (organisationId && externalWorkspaces.length > 0) {
			return <OrganisationExternalView organisationId={organisationId} />;
		}
		return (
			<Center style={{ height: "60vh" }}>
				<Stack align="center">
					<Title order={3} fw={400}>
						<Trans>Organisation not found</Trans>
					</Title>
					<Button variant="outline" onClick={() => navigate("/o")}>
						<Trans>Back</Trans>
					</Button>
				</Stack>
			</Center>
		);
	}

	return (
		<Container size="xl" py="xl" px="lg">
			{/* Skipped on overview (cards + top SeatCapBanner already cover it);
			    kept on other tabs where it's the only org-wide cap signal. */}
			{organisationId && view !== "overview" && (
				<OrganisationCapBanner
					organisationId={organisationId}
					workspaces={workspaces}
				/>
			)}
			<Stack gap={24}>
				{/* Header — minimal. Name + counts on the left, action cluster
				    on the right. Tier is intentionally absent (it's a
				    per-workspace concept, shown in the column headers). */}
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Group gap="md" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
						{organisation.logo_url && (
							<Image
								src={resolveLogoUrl(organisation.logo_url)}
								alt={t`${organisation.name} logo`}
								h={48}
								w="auto"
								fit="contain"
								style={{ flexShrink: 0, maxWidth: 160 }}
							/>
						)}
						<Stack gap={2} style={{ minWidth: 0 }}>
							<Title order={3} fw={400}>
								{organisation.name}
							</Title>
							<Text size="sm" c="dimmed">
								{organisation.workspace_count}{" "}
								{organisation.workspace_count === 1
									? t`workspace`
									: t`workspaces`}{" "}
								· {organisation.member_count}{" "}
								{organisation.member_count === 1 ? t`person` : t`people`}
							</Text>
							{/* Matrix §5: organisation-level role set is Admin / Billing /
							    Member — no organisation-level Guest. Guest count intentionally
							    dropped from the header summary (HCD audit). */}
						</Stack>
					</Group>
					</Group>

				{/* Tabbed canvas per demo feedback. Overview holds organisation name
				    + logo (no more hunting for /o/:id/settings). Usage pulls
				    up the rollup + per-project table. People is the matrix.
				    Workspaces and Projects tabs retired — projects fold into
				    Usage; workspaces are reachable via the home selector. */}
				{/* Add-to-workspace and the cap banner both read from this list. */}
				{workspacesError && (
					<Alert color="red" variant="light" mb="md">
						<Trans>
							We couldn't load this organisation's workspaces. Some controls may
							be missing. Try refreshing.
						</Trans>
					</Alert>
				)}

				{/* Tab strip hidden — the main AppSidebar drives section
				    navigation. Internal Tabs.value still wires the panels via URL. */}
				<Tabs value={view} onChange={setView} keepMounted={false}>
					<Tabs.Panel value="overview" pt="md">
						{isSettingsPath ? (
							// Sidebar "Settings" lands here (/o/:id/settings/general):
							// organisation name + logo editing lives in settings, not
							// on the at-a-glance overview.
							<OverviewPanel
								organisation={organisation}
								organisationId={organisationId!}
								canEdit={isAdmin}
								queryClient={queryClient}
							/>
						) : (
							<OrganisationOverviewPanel
								organisation={organisation}
								members={members}
								workspaces={workspaces}
								isManager={isAdmin}
								onOpenWorkspace={(id) => navigate(`/w/${id}/home`)}
								onOpenProject={(wsId, projectId) =>
									navigate(`/w/${wsId}/projects/${projectId}/home`)
								}
								onRequestWorkspace={() =>
									navigate(`/w/new?organisationId=${organisationId}`)
								}
							/>
						)}
					</Tabs.Panel>

					{canSeeFinancials && (
						<Tabs.Panel value="usage" pt="md">
							<Stack gap="md">
								{organisationId && (
									<OrganisationUsageRollup orgId={organisationId} />
								)}
							</Stack>
						</Tabs.Panel>
					)}

					{canSeeFinancials && (
						<Tabs.Panel value="billing" pt="md">
							<Paper withBorder p="md" radius="sm">
								<Stack gap={8}>
									<Text size="sm" fw={500}>
										<Trans>Billing</Trans>
									</Text>
									<Text size="sm" c="dimmed">
										<Trans>
											Organisation billing is handled through support. For
											invoices, payment changes, or a shared contract, email{" "}
											<Anchor href="mailto:support@dembrane.com">
												support@dembrane.com
											</Anchor>
											.
										</Trans>
									</Text>
								</Stack>
							</Paper>
						</Tabs.Panel>
					)}

					<Tabs.Panel value="people" pt="md">
						<Stack gap="md">
							<MembersToolbar
								search={search}
								onSearchChange={setSearch}
								filter={{
									onChange: (v) => setRoleFilter(v as RoleFilter),
									options: [
										{ label: t`All`, value: "all" },
										{ label: t`Admins`, value: "admins" },
										...(hasBilling
											? [{ label: t`Billing`, value: "billing" }]
											: []),
										{ label: t`Members`, value: "members" },
										...(hasExternals
											? [{ label: t`Externals`, value: "externals" }]
											: []),
									],
									value: roleFilter,
								}}
								count={{ shown: filteredMembers.length, total: members.length }}
								error={
									membersError
										? t`Couldn't load organisation members. Try refreshing, and if it keeps failing, contact support.`
										: null
								}
							/>

							{/* Hero empty state — matches ProjectsHome pattern (audit §7).
				    A organisation with zero members is vanishingly rare in practice
				    (the organisation creator is always the first admin), but the
				    matrix rendered silently when it happened; surface that
				    instead so the state isn't "app looks broken." */}
							{!membersError && members.length === 0 && (
								<Stack align="center" gap={6} py={48}>
									<Title order={4} fw={400}>
										<Trans>No one on the organisation yet.</Trans>
									</Title>
									<Text size="sm" c="dimmed" ta="center" maw={400}>
										<Trans>
											Organisation members appear here once they join a
											workspace. Invites are sent from each workspace's Members
											tab.
										</Trans>
									</Text>
								</Stack>
							)}

							{/* Members list: dotted invite card as the first row (same
				    shape as any other member), then one OrganisationPersonCard per
				    person. Externals render inline with an External badge so
				    admins see everyone reaching their data in one list. */}
							{!membersError && (
								<Stack gap="xs">
									{isAdmin && (
										<InviteMemberCard
											label={<Trans>Invite people</Trans>}
											helperText={
												<Trans>
													Invite to a workspace, or just the organisation.
												</Trans>
											}
											onClick={() => setInviteOpen(true)}
										/>
									)}
									{members.length === 0 && (
										<Stack align="center" gap={6} py={48}>
											<Title order={4} fw={400}>
												<Trans>No one on the organisation yet.</Trans>
											</Title>
											<Text size="sm" c="dimmed" ta="center" maw={400}>
												<Trans>
													Organisation members appear here once they join a
													workspace.
												</Trans>
											</Text>
										</Stack>
									)}
									{filteredMembers.map((m) => (
										<OrganisationPersonCard
											key={m.user_id}
											member={m}
											workspaces={workspaces}
											isAdmin={isAdmin}
											isSelf={m.app_user_id === myAppUserId}
											onOrganisationRoleChange={(next) =>
												organisationRoleMutation.mutate({
													role: next,
													userId: m.user_id,
												})
											}
											onWorkspaceRoleChange={(ws, membershipId, next) =>
												workspaceRoleMutation.mutate({
													membershipId,
													role: next,
													workspaceId: ws,
												})
											}
											onAddToWorkspace={(ws, role) =>
												addToWorkspaceMutation.mutate({
													email: m.email,
													role,
													workspaceId: ws,
												})
											}
											onRemove={() =>
												removeOrganisationMemberMutation.mutate({
													userId: m.user_id,
												})
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
							{organisationId && organisation && (
								<InviteModal
									opened={inviteOpen}
									onClose={() => setInviteOpen(false)}
									orgId={organisationId}
									orgName={organisation.name}
								/>
							)}

							{isAdmin && organisationId && (
								<PendingInvitesSection orgId={organisationId} scope="org" />
							)}

							<Text size="xs" c="dimmed">
								<Trans>
									Admins can reach every workspace in this organisation. Members
									and externals only see the workspaces they've been given
									access to.
								</Trans>
							</Text>
						</Stack>
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</Container>
	);
};

// ── Overview panel — organisation name + logo edit + counts ─────────────────

async function updateOrganisationFromOverview(
	organisationId: string,
	body: { name?: string; description?: string },
) {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${organisationId}`, {
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
	organisation,
	organisationId,
	canEdit,
	queryClient,
}: {
	organisation: OrganisationDetail;
	organisationId: string;
	canEdit: boolean;
	queryClient: ReturnType<typeof useQueryClient>;
}) {
	// Autosave on blur — matches the inline-edit pattern elsewhere in the
	// app (HostGuide titles, project portal). Local state lets the user
	// type without every keystroke round-tripping; blur commits.
	const [name, setName] = useState(organisation.name);
	const [description, setDescription] = useState(
		organisation.description ?? "",
	);

	const invalidate = () => {
		queryClient.invalidateQueries({
			queryKey: ["v2", "organisation", organisationId],
		});
		queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
	};

	const saveMutation = useMutation({
		mutationFn: (body: { name?: string; description?: string }) =>
			updateOrganisationFromOverview(organisationId, body),
		onError: (err: Error) => {
			// Roll back local state on failure so what's shown matches
			// what's actually stored.
			setName(organisation.name);
			setDescription(organisation.description ?? "");
			toast.error(err.message);
		},
		onSuccess: () => {
			invalidate();
			toast.success(t`Saved`);
		},
	});

	return (
		<Stack gap="lg">
			{/* Organisation identity — name + description + logo. Admins edit
			    inline; others read. */}
			<Stack gap="md">
				<TextInput
					label={t`Organisation name`}
					description={t`Shown in the organisation header and in email subject lines.`}
					value={name}
					disabled={!canEdit || saveMutation.isPending}
					onChange={(e) => setName(e.currentTarget.value)}
					onBlur={() => {
						const next = name.trim();
						if (next && next !== organisation.name) {
							saveMutation.mutate({ name: next });
						} else if (!next) {
							setName(organisation.name);
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
						if (e.key === "Escape") {
							setName(organisation.name);
							(e.currentTarget as HTMLInputElement).blur();
						}
					}}
					maxLength={100}
				/>
				<Textarea
					label={t`Description`}
					description={t`A short blurb shown on the organisation overview.`}
					value={description}
					disabled={!canEdit || saveMutation.isPending}
					autosize
					minRows={2}
					maxRows={6}
					onChange={(e) => setDescription(e.currentTarget.value)}
					onBlur={() => {
						const next = description.trim();
						if (next !== (organisation.description ?? "")) {
							saveMutation.mutate({ description: next });
						}
					}}
					maxLength={2000}
				/>
			</Stack>

			{/* Count tiles dropped 2026-04-23: the organisation header subtitle
			    already says "N workspaces · M people", and the Usage /
			    People tabs hold the detailed views. Repeating the same
			    numbers on Overview was just noise. */}

			{/* Danger section — not wired to a self-serve delete yet
			    (no backend endpoint; ownership transfer + organisation delete
			    are support flows for now). Primes the audit §3 pattern
			    without offering a fake affordance. Admin only. */}
			{canEdit && (
				<Stack gap={4} mt="xl">
					<Text size="xs" fw={500} tt="uppercase" c="red.9" lts={0.5}>
						<Trans>Danger</Trans>
					</Text>
					<Text size="sm" c="dimmed">
						<Trans>
							Deleting a organisation is a support-assisted operation. Email{" "}
							<Anchor href="mailto:support@dembrane.com">
								support@dembrane.com
							</Anchor>{" "}
							and we'll walk through it with you — all workspaces must be empty
							and deleted first.
						</Trans>
					</Text>
				</Stack>
			)}
		</Stack>
	);
}

// ── Organisation overview — people bubbles + workspace cards ────────────────
//
// The at-a-glance landing for /o/:id/overview. People first (who's on the
// team), then the workspaces the caller actually has access to (same
// membership-scoped source the sidebar uses), then a discovery surface for
// workspaces they can join/request, plus any pending workspace requests.
// Editing (name/logo) lives in Settings, reached from the sidebar.

interface MyWorkspace {
	id: string;
	name: string;
	org_id: string;
	role: string;
	tier: string;
	project_count: number;
	member_count: number;
	members_preview?: WorkspaceMemberPreview[];
	usage?: { audio_hours?: number; conversation_count?: number };
	has_pending_upgrade_request?: boolean;
	created_at?: string | null;
}

interface PendingWorkspaceRequest {
	id: string;
	kind: string;
	proposed_name: string | null;
	proposed_tier: string;
	org_id: string;
	created_at: string | null;
}

async function fetchMyWorkspaces(): Promise<{
	workspaces: MyWorkspace[];
	pending_workspace_requests: PendingWorkspaceRequest[];
}> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		credentials: "include",
	});
	if (!res.ok) {
		throw new Error(`Workspaces request failed (${res.status})`);
	}
	return res.json();
}

interface WorkspaceCardModel {
	id: string;
	name: string;
	tier: string;
	project_count: number;
	member_count: number;
	members_preview: WorkspaceMemberPreview[];
	audio_hours: number;
	conversation_count: number;
	is_private: boolean;
	pinned_projects: WorkspacePinnedProject[];
	recently_approved: boolean;
	has_pending_upgrade_request: boolean;
}

function OrganisationOverviewPanel({
	organisation,
	members,
	workspaces,
	isManager,
	onOpenWorkspace,
	onOpenProject,
	onRequestWorkspace,
}: {
	organisation: OrganisationDetail;
	members: OrganisationMember[];
	// Org roster (manager view / People matrix). Only consulted here for
	// per-workspace pinned projects + private flag — the cards themselves are
	// driven by the caller's own membership list so we never show a workspace
	// the user can't actually open.
	workspaces: OrganisationWorkspace[];
	isManager: boolean;
	onOpenWorkspace: (workspaceId: string) => void;
	onOpenProject: (workspaceId: string, projectId: string) => void;
	onRequestWorkspace: () => void;
	}) {
		const orgId = organisation.id;
		const navigate = useI18nNavigate();

		const handlePeopleClick = () => {
			navigate(`/o/${orgId}/settings/members`);
		};

		// The caller's own workspaces (direct memberships) + their pending
	// new-workspace / upgrade requests. Same endpoint the home page used.
	const { data: mine } = useQuery({
		queryFn: fetchMyWorkspaces,
		queryKey: ["v2", "workspaces"],
		staleTime: 30_000,
	});

	// Pinned projects + private flag live on the enriched org roster; key them
	// by workspace id so the access-scoped cards can pull them in.
	const rosterMap = useMemo(
		() => new Map(workspaces.map((w) => [w.id, w])),
		[workspaces],
	);

	const ONE_DAY_MS = 86_400_000;
	const myCards: WorkspaceCardModel[] = useMemo(() => {
		const list = (mine?.workspaces ?? []).filter((w) => w.org_id === orgId);
		return list
			.map((w) => {
				const roster = rosterMap.get(w.id);
				// Free workspaces are auto-created on signup, never "approved".
				const recentlyApproved =
					!!w.created_at &&
					w.tier !== "free" &&
					Date.now() - new Date(w.created_at).getTime() < ONE_DAY_MS;
				return {
					audio_hours: w.usage?.audio_hours ?? 0,
					conversation_count: w.usage?.conversation_count ?? 0,
					has_pending_upgrade_request: !!w.has_pending_upgrade_request,
					id: w.id,
					is_private: roster?.is_private ?? false,
					member_count: w.member_count,
					members_preview: w.members_preview ?? [],
					name: w.name,
					pinned_projects: roster?.pinned_projects ?? [],
					project_count: w.project_count,
					recently_approved: recentlyApproved,
					tier: w.tier,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [mine, orgId, rosterMap]);

	const pendingRequests = (mine?.pending_workspace_requests ?? []).filter(
		(r) => r.org_id === orgId,
	);

	// Pending invites aren't on the team yet, so they don't count toward the
	// people glance. Everyone with access (incl. externals) shows as a bubble.
	const people = members.filter((m) => !m.is_pending);
	const MAX_BUBBLES = 8;
	const visiblePeople = people.slice(0, MAX_BUBBLES);
	const overflowPeople = people.length - visiblePeople.length;

	return (
		<Stack gap={32}>
			{organisation.description && (
				<Text
					size="sm"
					c="dimmed"
					style={{ maxWidth: 640, whiteSpace: "pre-wrap" }}
				>
					{organisation.description}
				</Text>
			)}

			<Stack gap="sm">
				<Group gap="xs" align="baseline">
					<Title order={4} fw={500}>
						<Trans>People</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						{people.length}
					</Text>
				</Group>
					{people.length === 0 ? (
						<Text size="sm" c="dimmed">
							<Trans>No one on this organisation yet.</Trans>
						</Text>
					) : (
						<Tooltip.Group>
							<Avatar.Group spacing="sm">
								{visiblePeople.map((m) => (
									<Tooltip
										key={m.user_id}
										label={`${m.display_name} · ${
											m.is_external ? t`External` : displayRole(m.role)
										}`}
										withArrow
									>
										<Avatar
											size={36}
											radius="xl"
											src={avatarUrl(m.avatar)}
											color="primary"
											style={{ cursor: "pointer" }}
											onClick={handlePeopleClick}
										>
											{memberInitials(m.display_name, m.email)}
										</Avatar>
									</Tooltip>
								))}
								{overflowPeople > 0 && (
									<Avatar
										size={36}
										radius="xl"
										color="gray"
										style={{ cursor: "pointer" }}
										onClick={handlePeopleClick}
									>
										+{overflowPeople}
									</Avatar>
								)}
								{isManager && (
									<Tooltip label={t`Manage members`} withArrow>
										<Avatar
											size={36}
											radius="xl"
											color="primary"
											variant="light"
											style={{ cursor: "pointer" }}
											onClick={handlePeopleClick}
										>
											<IconPlus size={16} />
										</Avatar>
									</Tooltip>
								)}
							</Avatar.Group>
						</Tooltip.Group>
					)}
			</Stack>

			<Stack gap="sm">
				<Group justify="space-between" align="center">
					<Group gap="xs" align="baseline">
						<Title order={4} fw={500}>
							<Trans>Workspaces</Trans>
						</Title>
						<Text size="sm" c="dimmed">
							{myCards.length}
						</Text>
					</Group>
					{isManager && (
						<Button
							variant="subtle"
							size="xs"
							leftSection={<IconPlus size={14} />}
							onClick={onRequestWorkspace}
						>
							<Trans>Request workspace</Trans>
						</Button>
					)}
				</Group>
				{myCards.length === 0 && pendingRequests.length === 0 ? (
					<Text size="sm" c="dimmed">
						<Trans>
							You haven't joined any workspace in this organisation yet.
						</Trans>
					</Text>
				) : (
					<SimpleGrid cols={{ base: 1, lg: 3, sm: 2 }} spacing="md">
						{myCards.map((ws) => (
							<OrganisationWorkspaceCard
								key={ws.id}
								workspace={ws}
								onOpen={() => onOpenWorkspace(ws.id)}
								onOpenProject={(projectId) => onOpenProject(ws.id, projectId)}
							/>
						))}
						{pendingRequests.map((r) => (
							<PendingRequestCard key={r.id} request={r} />
						))}
					</SimpleGrid>
				)}
			</Stack>

			{/* Workspaces in this org the caller isn't a member of but can join or
			    request access to. Self-hides when there's nothing to surface. */}
			<DiscoverableWorkspaces orgId={orgId} />
		</Stack>
	);
}

/**
 * "Request submitted" placeholder card for a pending new-workspace or
 * tier-upgrade request, so the requester sees their ask is in flight.
 */
function PendingRequestCard({ request }: { request: PendingWorkspaceRequest }) {
	const capitalizedTier =
		request.proposed_tier.charAt(0).toUpperCase() +
		request.proposed_tier.slice(1);

	return (
		<Paper
			p="lg"
			radius="md"
			style={{
				background: "var(--mantine-color-yellow-0)",
				border: "1px dashed var(--mantine-color-yellow-4)",
				opacity: 0.85,
			}}
		>
			<Stack gap={12}>
				<Group gap="sm" wrap="nowrap" align="flex-start">
					<IconClock
						size={20}
						style={{
							color: "var(--mantine-color-yellow-6)",
							flexShrink: 0,
							marginTop: 2,
						}}
					/>
					<Box flex={1} style={{ minWidth: 0 }}>
						<Text fw={500} size="md" lineClamp={1}>
							{request.kind === "new_workspace"
								? (request.proposed_name ?? t`New workspace`)
								: t`Upgrade request`}
						</Text>
						<Text size="xs" c="dimmed" lineClamp={1}>
							{capitalizedTier}
						</Text>
					</Box>
				</Group>
				<Text size="xs" c="dimmed">
					<Trans>Pending review</Trans>
				</Text>
			</Stack>
		</Paper>
	);
}

function WorkspaceMemberBubbles({
	members,
	count,
}: {
	members: WorkspaceMemberPreview[];
	count: number;
}) {
	const MAX_VISIBLE = 3;
	const visible = members.slice(0, MAX_VISIBLE);
	const overflow = count - visible.length;
	if (visible.length === 0 && overflow <= 0) return null;

	return (
		<Tooltip.Group>
			<Avatar.Group spacing="sm">
				{visible.map((m, i) => (
					<Tooltip
						key={`${m.display_name}-${i}`}
						label={m.display_name}
						withArrow
					>
						<Avatar
							size={26}
							radius="xl"
							src={avatarUrl(m.avatar)}
							color="primary"
						>
							{memberInitials(m.display_name)}
						</Avatar>
					</Tooltip>
				))}
				{overflow > 0 && (
					<Avatar size={26} radius="xl" color="gray">
						+{overflow}
					</Avatar>
				)}
			</Avatar.Group>
		</Tooltip.Group>
	);
}

function OrganisationWorkspaceCard({
	workspace,
	onOpen,
	onOpenProject,
}: {
	workspace: WorkspaceCardModel;
	onOpen: () => void;
	onOpenProject: (projectId: string) => void;
}) {
	const capitalizedTier =
		workspace.tier.charAt(0).toUpperCase() + workspace.tier.slice(1);
	const audioHours = workspace.audio_hours;
	const conversationCount = workspace.conversation_count;
	const membersPreview = workspace.members_preview;
	const pinned = workspace.pinned_projects;

	return (
		<Paper
			p="lg"
			radius="md"
			withBorder
			role="button"
			tabIndex={0}
			className="hover:!border-primary-400 transition-colors"
			style={{
				cursor: "pointer",
			}}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
		>
			<Stack gap={12}>
				<Group gap="xs" wrap="nowrap" align="center">
					<Text
						fw={500}
						size="md"
						lineClamp={1}
						style={{ flex: 1, minWidth: 0 }}
					>
						{workspace.name}
					</Text>
					{workspace.is_private && (
						<Tooltip label={t`Private workspace`}>
							<span style={{ display: "inline-flex", flexShrink: 0 }}>
								<IconLock size={14} color="var(--mantine-color-gray-6)" />
							</span>
						</Tooltip>
					)}
				</Group>
				<Text size="xs" c="dimmed" lineClamp={1}>
					{capitalizedTier}
				</Text>

				<Group gap="lg" wrap="wrap">
					<Text size="xs" c="dimmed">
						{workspace.project_count}{" "}
						{workspace.project_count === 1 ? t`project` : t`projects`}
					</Text>
					<Text size="xs" c="dimmed">
						{audioHours}h {t`total`}
					</Text>
					<Text size="xs" c="dimmed">
						{conversationCount}{" "}
						{conversationCount === 1 ? t`conversation` : t`conversations`}
					</Text>
				</Group>

				{pinned.length > 0 && (
					<Group gap={6} wrap="wrap">
						{pinned.map((p) => (
							<Badge
								key={p.id}
								size="sm"
								variant="light"
								color="gray"
								style={{ cursor: "pointer", textTransform: "none" }}
								onClick={(e) => {
									e.stopPropagation();
									onOpenProject(p.id);
								}}
							>
								{p.name || t`Untitled`}
							</Badge>
						))}
					</Group>
				)}

				<WorkspaceMemberBubbles
					members={membersPreview}
					count={workspace.member_count}
				/>

				{(workspace.recently_approved ||
					workspace.has_pending_upgrade_request) && (
					<Group gap={6}>
						{workspace.recently_approved && (
							<Badge
								size="xs"
								color="green"
								variant="light"
								leftSection={<IconSparkles size={10} />}
							>
								<Trans>Recently approved</Trans>
							</Badge>
						)}
						{workspace.has_pending_upgrade_request && (
							<Badge size="xs" color="yellow" variant="light">
								<Trans>Upgrade pending</Trans>
							</Badge>
						)}
					</Group>
				)}
			</Stack>
		</Paper>
	);
}

export default OrganisationRoute;

/**
 * One row on the organisation People tab. Summarizes a person's organisation role +
 * their per-workspace access, expands to let an admin change
 * per-workspace roles or remove the person from the organisation.
 *
 * Role changes go through a confirm modal (never silent). Uniform
 * per-workspace role shows as a single "Admin across all" pill
 * instead of listing each workspace — common case, less noise.
 */
function OrganisationPersonCard({
	member,
	workspaces,
	isAdmin,
	isSelf,
	onOrganisationRoleChange,
	onWorkspaceRoleChange,
	onAddToWorkspace,
	onRemove,
}: {
	member: OrganisationMember;
	workspaces: OrganisationWorkspace[];
	isAdmin: boolean;
	isSelf: boolean;
	onOrganisationRoleChange: (next: string) => void;
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
				isDirect: Boolean(directRole),
				membershipId: membershipId ?? null,
				role,
				ws,
			};
		});
	}, [
		workspaces,
		member.direct_workspace_roles,
		member.direct_workspace_membership_ids,
		member.role,
	]);

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

	const handleOrganisationRoleChange = (next: string) => {
		const person = member.display_name || member.email || t`this person`;
		modals.openConfirmModal({
			children: (
				<Text size="sm">
					<Trans>
						Change {person}'s organisation role from{" "}
						<em>{displayRole(member.role)}</em> to <em>{displayRole(next)}</em>?
					</Trans>
				</Text>
			),
			labels: { cancel: t`Cancel`, confirm: t`Change role` },
			onConfirm: () => onOrganisationRoleChange(next),
			title: t`Change organisation role?`,
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
			children: (
				<Text size="sm">
					<Trans>
						Change {person}'s role on {wsName} from{" "}
						<em>{displayRole(currentRole)}</em> to <em>{displayRole(next)}</em>?
					</Trans>
				</Text>
			),
			labels: { cancel: t`Cancel`, confirm: t`Change role` },
			onConfirm: () => onWorkspaceRoleChange(wsId, membershipId, next),
			title: t`Change workspace role?`,
		});
	};

	const handleRemove = () => {
		const person = member.display_name || member.email || t`this person`;
		modals.openConfirmModal({
			children: (
				<Stack gap={8}>
					<Text size="sm">
						<Trans>
							{person} will lose access to every workspace in this organisation.
							Direct-only workspace invites stay intact.
						</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>You can re-invite them later from any workspace.</Trans>
					</Text>
				</Stack>
			),
			confirmProps: { color: "red" },
			labels: { cancel: t`Cancel`, confirm: t`Remove` },
			onConfirm: onRemove,
			title: t`Remove from organisation?`,
		});
	};

	return (
		<Paper withBorder radius="md" p="md">
			<Stack gap={open ? 12 : 0}>
				<Group justify="space-between" wrap="nowrap" gap="md">
					<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
						<Avatar src={avatarUrl(member.avatar, 64)} size="md" radius="xl">
							{memberInitials(member.display_name, member.email)}
						</Avatar>
						<Stack gap={0} style={{ minWidth: 0 }}>
							<Text size="sm" fw={500} truncate>
								{member.display_name || member.email || t`Unknown member`}
							</Text>
							{member.email && member.email !== member.display_name && (
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
							<Tooltip
								label={t`No organisation role. Access via workspace invites.`}
								multiline
								w={240}
							>
								<Badge size="sm" variant="light" color="gray">
									<Trans>External</Trans>
								</Badge>
							</Tooltip>
						) : (
							<RoleBadgeMenu
								currentRole={member.role}
								options={ORGANISATION_ROLE_OPTIONS}
								disabled={!isAdmin || isSelf}
								onChange={handleOrganisationRoleChange}
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
											<IconLock size={12} color="var(--mantine-color-gray-6)" />
										)}
										<Text size="sm" truncate>
											{ws.name}
										</Text>
									</Group>
									{role ? (
										// External rows can't be flipped to/from a non-external
										// role from this dropdown (ADR-0003). Promotion goes
										// through the explicit add-to-org + re-invite flow.
										role === "external" ? (
											<Tooltip
												label={t`No workspace role change. Add this person to the organisation, then re-invite from the workspace.`}
												multiline
												w={260}
											>
												<Badge
													size="xs"
													variant="light"
													color={roleColor(role)}
												>
													{displayRole(role)}
												</Badge>
											</Tooltip>
										) : isAdmin && isDirect && membershipId ? (
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
														: t`Admin here via organisation role`
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
										// workspace invite endpoint with a non-external role
										// so the server sees this as a direct grant,
										// not a fresh invitation.
										<Button
											size="compact-xs"
											variant="subtle"
											leftSection={<IconPlus size={12} />}
											onClick={() => {
												const nextRole = member.is_external
													? "external"
													: "member";
												modals.openConfirmModal({
													children: (
														<Text size="sm">
															<Trans>
																Add{" "}
																{member.display_name ||
																	member.email ||
																	t`this person`}{" "}
																to {ws.name} as <em>{displayRole(nextRole)}</em>
																?
															</Trans>
														</Text>
													),
													labels: {
														cancel: t`Cancel`,
														confirm: t`Add`,
													},
													onConfirm: () => onAddToWorkspace(ws.id, nextRole),
													title: t`Add to ${ws.name}?`,
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
									<Trans>Remove from organisation</Trans>
								</Button>
							</Group>
						)}
					</Stack>
				)}
			</Stack>
		</Paper>
	);
}
