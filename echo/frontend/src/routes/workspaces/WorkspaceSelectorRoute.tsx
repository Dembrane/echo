import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Avatar,
	Badge,
	Box,
	Button,
	Container,
	Divider,
	Group,
	Image,
	Loader,
	Paper,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconClock, IconPlus, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { DiscoverableWorkspaces } from "@/components/workspace/DiscoverableWorkspaces";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useMyInvites } from "@/hooks/useMyInvites";
import { useUrlSearch } from "@/hooks/useUrlSearch";
import { useWorkspace } from "@/hooks/useWorkspace";
import { logoUrl as resolveLogoUrl } from "@/lib/avatar";
import { displayRole } from "@/lib/roles";
import { formatDurationFromHours } from "@/lib/time";

interface MemberPreview {
	display_name: string;
	avatar: string | null;
}

interface WorkspaceUsage {
	audio_hours: number;
	conversation_count: number;
	hours_included?: number | null;
	hours_pct?: number | null;
	at_cap?: boolean;
	approaching_cap?: boolean;
}

interface Workspace {
	id: string;
	name: string;
	org_id: string;
	org_name: string;
	role: string;
	is_default: boolean;
	tier: string;
	logo_url: string | null;
	org_logo_url: string | null;
	project_count: number;
	member_count: number;
	is_external: boolean;
	members_preview: MemberPreview[];
	usage: WorkspaceUsage;
	has_pending_upgrade_request?: boolean;
}

interface OrganisationRollup {
	id: string;
	name: string;
	role: string;
	logo_url: string | null;
	total_projects: number;
	total_members: number;
	total_audio_hours: number;
	total_conversations: number;
	workspace_count: number;
}

interface RecentRemoval {
	workspace_id: string;
	workspace_name: string;
	org_name: string;
	ended_at: string;
}

interface PendingWorkspaceRequest {
	id: string;
	kind: string;
	status: string;
	proposed_name: string | null;
	proposed_tier: string;
	org_id: string;
	org_name: string;
	created_at: string | null;
}

async function fetchWorkspaces(): Promise<{
	workspaces: Workspace[];
	organisations: OrganisationRollup[];
	recent_removals: RecentRemoval[];
	pending_workspace_requests: PendingWorkspaceRequest[];
}> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		credentials: "include",
	});
	// Throw rather than [] — empty list is indistinguishable from "no workspaces".
	if (!res.ok) {
		throw new Error(`Workspaces request failed (${res.status})`);
	}
	return res.json();
}

function AvatarBubbles({
	members,
	count,
}: {
	members: MemberPreview[];
	count: number;
}) {
	const overflow = count - members.length;

	return (
		<Tooltip.Group>
			<Avatar.Group spacing="sm">
				{members.map((m, i) => (
					<Tooltip
						key={`${m.display_name}-${i}`}
						label={m.display_name}
						withArrow
					>
						<Avatar
							size={28}
							radius="xl"
							src={
								m.avatar ? `${DIRECTUS_PUBLIC_URL}/assets/${m.avatar}` : null
							}
							color="blue"
						>
							{m.display_name?.charAt(0)?.toUpperCase()}
						</Avatar>
					</Tooltip>
				))}
				{overflow > 0 && (
					<Avatar size={28} radius="xl" color="gray">
						+{overflow}
					</Avatar>
				)}
			</Avatar.Group>
		</Tooltip.Group>
	);
}

function WorkspaceCard({
	workspace,
	onSelect,
	onManage,
}: {
	workspace: Workspace;
	onSelect: () => void;
	onManage?: () => void;
}) {
	const isAdminOrOwner =
		workspace.role === "admin" || workspace.role === "owner";
	const [hovered, setHovered] = useState(false);
	const wsLogo = resolveLogoUrl(workspace.logo_url);
	const organisationLogo = resolveLogoUrl(workspace.org_logo_url);
	// Logo rules (2026-04-24 ask, refined):
	//   - Guest workspace: ws logo if set, else organisation logo. A guest's
	//     anchor is the organisation that invited them — always show something
	//     so the card has a visual hook.
	//   - Internal workspace: only show the ws logo. No ws logo → no
	//     logo at all. The selector grid is already grouped under the
	//     organisation, so repeating the organisation logo on every internal card is
	//     just visual noise ("see here there is no special workspace
	//     icon so no need to show").
	const headerLogo = workspace.is_external
		? wsLogo || organisationLogo
		: wsLogo;
	// Calmer meta-line: role + tier as a single dimmed string, no
	// colored badges. The old design stacked two blue pills which made
	// every card shout "admin! pioneer!" at once. Only the at-limit
	// warning keeps color — it's the one actionable exception.
	const capitalizedTier =
		workspace.tier.charAt(0).toUpperCase() + workspace.tier.slice(1);
	const metaParts = workspace.is_external
		? [t`Guest of ${workspace.org_name}`]
		: [displayRole(workspace.role), capitalizedTier];

	return (
		<Paper
			p="lg"
			radius="md"
			withBorder
			style={{
				boxShadow: hovered ? "0 2px 12px rgba(0,0,0,0.08)" : undefined,
				cursor: "pointer",
				transition: "box-shadow 0.15s ease, transform 0.15s ease",
			}}
			onClick={onSelect}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocus={() => setHovered(true)}
			onBlur={() => setHovered(false)}
		>
			<Stack gap={12}>
				<Group gap="sm" wrap="nowrap" align="flex-start">
					{headerLogo && (
						<Tooltip
							label={`${capitalizedTier} · ${displayRole(workspace.role)}`}
						>
							<Image
								src={headerLogo}
								alt={t`${workspace.name} logo`}
								h={36}
								w="auto"
								fit="contain"
								style={{ flexShrink: 0, maxWidth: 80 }}
							/>
						</Tooltip>
					)}
					<Box flex={1} style={{ minWidth: 0 }}>
						<Text fw={500} size="md" lineClamp={1}>
							{workspace.name}
						</Text>
						<Tooltip
							label={t`${capitalizedTier} · tap to see what's included`}
							position="bottom-start"
							withArrow
							disabled={workspace.is_external}
						>
							<Text size="xs" c="dimmed" lineClamp={1}>
								{metaParts.join(" · ")}
							</Text>
						</Tooltip>
					</Box>
				</Group>

				<Group gap="lg" wrap="wrap">
					<Text size="xs" c="dimmed">
						<Plural
							value={workspace.project_count}
							one="# project"
							other="# projects"
						/>
					</Text>
					<Text size="xs" c="dimmed">
						{workspace.usage.audio_hours}h {t`total`}
					</Text>
					<Text size="xs" c="dimmed">
						<Plural
							value={workspace.usage.conversation_count}
							one="# conversation"
							other="# conversations"
						/>
					</Text>
				</Group>

				<Group justify="space-between" align="center">
					<AvatarBubbles
						members={workspace.members_preview}
						count={workspace.member_count}
					/>
					<Group gap={8}>
						{isAdminOrOwner && onManage && (
							<Button
								size="compact-xs"
								variant="subtle"
								color="gray"
								leftSection={<IconSettings size={12} />}
								onClick={(e) => {
									e.stopPropagation();
									onManage();
								}}
								style={{
									opacity: hovered ? 1 : 0,
									transition: "opacity 0.15s ease",
								}}
							>
								<Trans>Manage</Trans>
							</Button>
						)}
					</Group>
				</Group>
				{(workspace.has_pending_upgrade_request ||
					workspace.usage.at_cap) && (
					<Group gap={6}>
						{workspace.has_pending_upgrade_request && (
							<Badge size="xs" color="yellow" variant="light">
								<Trans>Upgrade pending</Trans>
							</Badge>
						)}
						{workspace.usage.at_cap && (
							<Badge size="xs" color="red" variant="light">
								<Trans>Included hours used up</Trans>
							</Badge>
						)}
					</Group>
				)}
			</Stack>
		</Paper>
	);
}

/**
 * Dashed placeholder card that lives at the end of each organisation's workspace
 * grid for admins/owners. Clicking it navigates to /w/new?organisationId=<org>
 * so the create form knows which organisation to create inside.
 *
 * Solves the "create workspace BUT WHERE?" ambiguity — the card sits
 * physically under the organisation it belongs to, no confusion.
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
				border: "1px dashed var(--mantine-color-yellow-4)",
				background: "var(--mantine-color-yellow-0)",
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
								? request.proposed_name ?? t`New workspace`
								: t`Upgrade request`}
						</Text>
						<Text size="xs" c="dimmed" lineClamp={1}>
							{capitalizedTier}
						</Text>
					</Box>
				</Group>

				<Text size="xs" c="dimmed">
					<Trans>Pending review</Trans>
					{request.created_at &&
						` · ${new Date(request.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}
				</Text>
			</Stack>
		</Paper>
	);
}

function AddWorkspaceCard({ organisationId }: { organisationId: string }) {
	const navigate = useI18nNavigate();
	return (
		<Paper
			p="lg"
			radius="md"
			role="button"
			tabIndex={0}
			style={{
				alignItems: "center",
				background: "transparent",
				border: "1px dashed var(--mantine-color-gray-4)",
				cursor: "pointer",
				display: "flex",
				justifyContent: "center",
				minHeight: 140,
				transition: "border-color 0.15s ease, background 0.15s ease",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.borderColor = "var(--mantine-color-blue-5)";
				e.currentTarget.style.background = "rgba(65,105,225,0.03)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.borderColor = "var(--mantine-color-gray-4)";
				e.currentTarget.style.background = "transparent";
			}}
			onClick={() => navigate(`/w/new?organisationId=${organisationId}`)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					navigate(`/w/new?organisationId=${organisationId}`);
				}
			}}
		>
			<Stack gap={6} align="center">
				<IconPlus size={20} style={{ color: "var(--mantine-color-gray-6)" }} />
				<Text size="sm" c="dimmed">
					<Trans>Add workspace</Trans>
				</Text>
			</Stack>
		</Paper>
	);
}

interface OrgUsageLite {
	total_audio_hours: number;
	workspaces_at_cap: number;
	workspaces_approaching_cap: number;
	total_overage_forecast_eur: number | null;
}

async function fetchOrgUsageLite(orgId: string): Promise<OrgUsageLite | null> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/usage`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

function OrganisationHeroCard({
	organisation,
	onManage,
}: {
	organisation: OrganisationRollup;
	onManage: () => void;
}) {
	const isAdminOrOwner =
		organisation.role === "admin" || organisation.role === "owner";

	// Health hint — hours this cycle + at-cap count. Admin/billing get €
	// (server-gated). Non-admins still see cap warnings: knowing "2
	// workspaces are at limit" is actionable even for a plain member (they
	// can ask an admin for a different workspace to work in).
	const { data: usage } = useQuery({
		queryFn: () => fetchOrgUsageLite(organisation.id),
		queryKey: ["v2", "org-usage", organisation.id],
		// Same rationale as the full rollup: re-entering /w should show
		// fresh numbers on the org hero cards. Without this the at-limit
		// badges go stale until a manual hard-refresh.
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		staleTime: 60_000,
	});

	const organisationLogo = resolveLogoUrl(organisation.logo_url);

	return (
		<Paper p="lg" radius="md" withBorder>
			<Group justify="space-between" align="flex-start" wrap="nowrap">
				<Group gap="md" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
					{organisationLogo && (
						<Image
							src={organisationLogo}
							alt={t`${organisation.name} logo`}
							h={40}
							w="auto"
							fit="contain"
							style={{ flexShrink: 0, maxWidth: 120 }}
						/>
					)}
					<Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
						<Text fw={500} size="lg" lineClamp={1}>
							{organisation.name}
						</Text>
						<Text size="xs" c="dimmed">
							{isAdminOrOwner ? (
								<>
									<Plural
										value={organisation.workspace_count}
										one="# workspace"
										other="# workspaces"
									/>
									{" · "}
									<Plural
										value={organisation.total_members}
										one="# person"
										other="# people"
									/>
									{" · "}
									<Plural
										value={organisation.total_projects}
										one="# project"
										other="# projects"
									/>
								</>
							) : (
								// Server scopes counts to caller's memberships, so for
								// non-admins "0 workspaces" looks like "org is empty" — make scope explicit.
								<Plural
									value={organisation.workspace_count}
									one="# workspace you can access"
									other="# workspaces you can access"
								/>
							)}
							{usage && (
								<>
									{" · "}
									{formatDurationFromHours(usage.total_audio_hours)}{" "}
									{t`this month`}
								</>
							)}
						</Text>
						{/* Only at-cap Pilot blocks surface as a warning; the rest
					    is billed overage, not a hard limit. */}
						{usage && usage.workspaces_at_cap > 0 && (
							<Group gap={6} mt={4}>
								<Badge size="xs" color="red" variant="light">
									<Trans>{usage.workspaces_at_cap} at limit</Trans>
								</Badge>
							</Group>
						)}
					</Stack>
				</Group>
				{isAdminOrOwner && (
					<Button
						variant="subtle"
						size="xs"
						leftSection={<IconSettings size={14} />}
						onClick={onManage}
					>
						<Trans>Manage organisation</Trans>
					</Button>
				)}
			</Group>
		</Paper>
	);
}

export const WorkspaceSelectorRoute = () => {
	const navigate = useI18nNavigate();
	const { setWorkspace } = useWorkspace();
	const [search, setSearch] = useUrlSearch();

	useDocumentTitle(t`Workspaces | dembrane`);

	const { data, isLoading, isError, refetch } = useQuery({
		queryFn: fetchWorkspaces,
		queryKey: ["v2", "workspaces"],
		staleTime: 30_000,
	});

	// Pending invites for this user. Used by the empty state so a guest
	// who got bounced at the cap (or hasn't accepted yet) doesn't see the
	// "create your first workspace" copy that they can't act on.
	const { data: pendingInvites } = useMyInvites();

	const workspaces = data?.workspaces ?? [];
	const organisations = data?.organisations ?? [];
	const recentRemovals = data?.recent_removals ?? [];
	const pendingRequests = data?.pending_workspace_requests ?? [];
	const invites = pendingInvites ?? [];

	const filtered = search
		? workspaces.filter(
				(w) =>
					w.name.toLowerCase().includes(search.toLowerCase()) ||
					w.org_name.toLowerCase().includes(search.toLowerCase()),
			)
		: workspaces;

	// Group by organisation (org)
	const internalWorkspaces = filtered.filter((w) => !w.is_external);
	const externalWorkspaces = filtered.filter((w) => w.is_external);

	// Seed groups from `organisations` first — that way a organisation with zero workspaces
	// still renders a hero card + AddWorkspace affordance instead of getting
	// swallowed by the "no workspaces yet" empty state.
	const orgGroups = new Map<
		string,
		{ name: string; role: string; workspaces: Workspace[] }
	>();
	for (const organisation of organisations) {
		orgGroups.set(organisation.id, {
			name: organisation.name,
			role: organisation.role,
			workspaces: [],
		});
	}
	for (const w of internalWorkspaces) {
		const existing = orgGroups.get(w.org_id);
		if (existing) {
			existing.workspaces.push(w);
		} else {
			orgGroups.set(w.org_id, {
				name: w.org_name,
				role: w.role,
				workspaces: [w],
			});
		}
	}

	const handleSelect = (ws: Workspace) => {
		setWorkspace(ws.id);
		navigate(`/w/${ws.id}/projects`);
	};

	if (isLoading) {
		return (
			<Container size="md" py="xl">
				<Stack align="center" gap={16} mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	// Distinct from the empty-state branch below — a 5xx is not "no workspaces."
	if (isError) {
		return (
			<FetchErrorPanel
				onRetry={() => refetch()}
				message={
					<Trans>
						We couldn't load your workspaces. Check your connection and try
						again.
					</Trans>
				}
			/>
		);
	}

	return (
		<Container size="md" py="xl" px="lg">
			<Stack gap={32}>
				{/* Header — create-workspace is NOT up here. We put
					    "Add workspace" dashed cards inside each organisation's grid
					    so the placement answers "create where?" by itself. */}
				<Title order={3} fw={400}>
					<Trans>Workspaces</Trans>
				</Title>

				{/* Search (show when >3 workspaces) */}
				{workspaces.length > 3 && (
					<TextInput
						placeholder={t`Search workspaces...`}
						size="sm"
						value={search}
						onChange={(e) => setSearch(e.currentTarget.value)}
					/>
				)}

				{/* Organisation groups -- organisation hero card tops each group when a rollup
					    exists; falls back to a plain heading otherwise (designer
					    Ask 5: organisation-level context at top). Dividers between groups
					    (2026-04-24 ask) so each organisation/guest section reads as a
					    distinct block instead of one big stream. */}
				{Array.from(orgGroups.entries()).map(([orgId, group], idx) => {
					const organisation = organisations.find((t) => t.id === orgId);

					return (
						<Stack key={orgId} gap={16}>
							{idx > 0 && <Divider />}
							{organisation ? (
								<OrganisationHeroCard
									organisation={organisation}
									onManage={() => navigate(`/o/${orgId}`)}
								/>
							) : (
								<Text size="sm" fw={500}>
									{group.name}
								</Text>
							)}

							<SimpleGrid cols={{ base: 1, md: 3, sm: 2 }} spacing="md">
								{group.workspaces.map((ws) => (
									<WorkspaceCard
										key={ws.id}
										workspace={ws}
										onSelect={() => handleSelect(ws)}
										onManage={() => navigate(`/w/${ws.id}/settings`)}
									/>
								))}
								{pendingRequests
									.filter((r) => r.org_id === orgId)
									.map((r) => (
										<PendingRequestCard key={r.id} request={r} />
									))}
								{(group.role === "owner" || group.role === "admin") && (
									<AddWorkspaceCard organisationId={orgId} />
								)}
							</SimpleGrid>

							{/* Matrix §6: Slack-style discovery. Renders only
								    when there's something joinable/requestable and
								    hides itself otherwise. */}
							<DiscoverableWorkspaces orgId={orgId} />
						</Stack>
					);
				})}

				{/* External workspaces — quieter section, individual "guest of"
					    labels live on each card (designer Ask 5). */}
				{externalWorkspaces.length > 0 && (
					<Stack gap={12}>
						{orgGroups.size > 0 && <Divider />}
						<Text size="xs" fw={500} c="dimmed" tt="uppercase" lts={0.5}>
							<Trans>As a guest</Trans>
						</Text>
						<SimpleGrid cols={{ base: 1, md: 3, sm: 2 }} spacing="md">
							{externalWorkspaces.map((ws) => (
								<WorkspaceCard
									key={ws.id}
									workspace={ws}
									onSelect={() => handleSelect(ws)}
									// External guests don't manage the workspace they visit
									// — suppress the affordance.
									onManage={undefined}
								/>
							))}
						</SimpleGrid>
					</Stack>
				)}

				{/* Empty-state branches: pending invite (cap-bounced guest),
				    recent removal (admin freed a seat), or generic fallback. */}
				{workspaces.length === 0 &&
					organisations.length === 0 &&
					!isLoading &&
					(invites.length > 0 ? (
						<Stack align="center" gap={12} mt="10vh">
							<Text c="dimmed" size="sm" ta="center">
								<Trans>
									You have a pending invite to {invites[0].workspace_name}.
									The admin needs to free a seat before you can join.
								</Trans>
							</Text>
							<Button
								variant="default"
								size="sm"
								onClick={() => navigate("/invites")}
							>
								<Trans>View invite</Trans>
							</Button>
						</Stack>
					) : recentRemovals.length > 0 ? (
						<Stack align="center" gap={8} mt="10vh">
							<Text c="dimmed" size="sm" ta="center">
								<Trans>
									Your access to {recentRemovals[0].workspace_name} ended on{" "}
									{new Date(recentRemovals[0].ended_at).toLocaleDateString()}.
								</Trans>
							</Text>
							<Text c="dimmed" size="xs" ta="center">
								<Trans>
									Contact the admin if this was unexpected.
								</Trans>
							</Text>
						</Stack>
					) : (
						<Stack align="center" gap={8} mt="10vh">
							<Text c="dimmed" size="sm" ta="center">
								<Trans>You don't have access to any workspace right now.</Trans>
							</Text>
							<Text c="dimmed" size="sm" ta="center">
								<Trans>
									If you were expecting one, please ask the person who invited
									you to send it again.
								</Trans>
							</Text>
						</Stack>
					))}
			</Stack>
		</Container>
	);
};
