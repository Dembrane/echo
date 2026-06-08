import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Container,
	Group,
	Image,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useMyInvites } from "@/hooks/useMyInvites";
import { logoUrl as resolveLogoUrl } from "@/lib/avatar";

// The home page is now a plain list of organisations the user belongs to.
// Rich workspace cards (members, stats, pinned projects) moved down a level to
// the org overview (/o/:id). No workspace cards, stats rollups, or widgets here.

interface OrganisationRollup {
	id: string;
	name: string;
	role: string;
	logo_url: string | null;
	total_members: number;
	workspace_count: number;
}

interface WorkspaceLite {
	id: string;
	org_id: string;
	org_name: string;
	org_logo_url: string | null;
	role: string;
}

interface RecentRemoval {
	workspace_id: string;
	workspace_name: string;
	org_name: string;
	ended_at: string;
}

async function fetchWorkspaces(): Promise<{
	workspaces: WorkspaceLite[];
	organisations: OrganisationRollup[];
	recent_removals: RecentRemoval[];
}> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		credentials: "include",
	});
	// Throw rather than [] — empty list is indistinguishable from "no access".
	if (!res.ok) {
		throw new Error(`Workspaces request failed (${res.status})`);
	}
	return res.json();
}

interface OrgListItem {
	id: string;
	name: string;
	logo_url: string | null;
	memberCount: number | null;
	isExternal: boolean;
}

// External orgs are derived from external workspaces: they aren't in the
// membership rollup but the user still needs a way into them.
function deriveOrgList(
	organisations: OrganisationRollup[],
	workspaces: WorkspaceLite[],
): OrgListItem[] {
	const internalOrgs: OrgListItem[] = organisations.map((o) => ({
		id: o.id,
		isExternal: false,
		logo_url: o.logo_url,
		memberCount: o.total_members,
		name: o.name,
	}));

	const internalOrgIds = new Set(internalOrgs.map((o) => o.id));
	const externalOrgMap = new Map<string, OrgListItem>();
	for (const w of workspaces) {
		if (w.role !== "external" || !w.org_id) continue;
		if (internalOrgIds.has(w.org_id)) continue;
		if (!externalOrgMap.has(w.org_id)) {
			externalOrgMap.set(w.org_id, {
				id: w.org_id,
				isExternal: true,
				logo_url: w.org_logo_url,
				memberCount: null,
				name: w.org_name || t`Organisation`,
			});
		}
	}

	return [...internalOrgs, ...externalOrgMap.values()].sort((a, b) => {
		if (a.isExternal !== b.isExternal) return a.isExternal ? 1 : -1;
		return a.name.localeCompare(b.name);
	});
}

// Entry decision: single-org users go straight to their org overview, everyone
// else to the home list. Lives at the root (not inside /o) so the shortcut
// fires once on entry and doesn't bounce single-org users off /o on every visit.
export const RootRedirect = () => {
	const { data, isLoading, isError } = useQuery({
		queryFn: fetchWorkspaces,
		queryKey: ["v2", "workspaces"],
		staleTime: 30_000,
	});

	if (isLoading) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" gap={16} mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	// On error fall through to the home list, which renders its own error panel.
	// Relative targets keep any active /:language prefix intact.
	if (isError || !data) {
		return <Navigate to="o" replace />;
	}

	const orgList = deriveOrgList(
		data.organisations ?? [],
		data.workspaces ?? [],
	);
	if (orgList.length === 1) {
		return <Navigate to={`o/${orgList[0].id}/overview`} replace />;
	}
	return <Navigate to="o" replace />;
};

function OrgRow({ org, onOpen }: { org: OrgListItem; onOpen: () => void }) {
	const logo = resolveLogoUrl(org.logo_url);
	return (
		<Paper
			p="md"
			radius="md"
			withBorder
			role="button"
			tabIndex={0}
			style={{ cursor: "pointer", transition: "box-shadow 0.15s ease" }}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.boxShadow = "0 2px 12px rgba(0,0,0,0.08)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.boxShadow = "";
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap="md">
				<Group gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
					{logo && (
						<Image
							src={logo}
							alt={t`${org.name} logo`}
							h={32}
							w="auto"
							fit="contain"
							style={{ flexShrink: 0, maxWidth: 96 }}
						/>
					)}
					<Box style={{ minWidth: 0 }}>
						<Group gap={8} wrap="nowrap">
							<Text fw={500} size="md" lineClamp={1}>
								{org.name}
							</Text>
							{org.isExternal && (
								<Badge size="xs" variant="light" color="gray">
									<Trans>External</Trans>
								</Badge>
							)}
						</Group>
						{org.memberCount !== null && (
							<Text size="xs" c="dimmed">
								<Plural
									value={org.memberCount}
									one="# person"
									other="# people"
								/>
							</Text>
						)}
					</Box>
				</Group>
				<IconChevronRight
					size={16}
					style={{ color: "var(--mantine-color-gray-5)", flexShrink: 0 }}
				/>
			</Group>
		</Paper>
	);
}

export const WorkspaceSelectorRoute = () => {
	const navigate = useI18nNavigate();

	useDocumentTitle(t`Organisations | dembrane`);

	const { data, isLoading, isError, refetch } = useQuery({
		queryFn: fetchWorkspaces,
		queryKey: ["v2", "workspaces"],
		staleTime: 30_000,
	});

	// Pending invites for this user. Used by the empty state so a guest who got
	// bounced at the cap (or hasn't accepted yet) doesn't see the "no access"
	// copy that they can't act on.
	const { data: pendingInvites } = useMyInvites();

	const organisations = data?.organisations ?? [];
	const workspaces = data?.workspaces ?? [];
	const recentRemovals = data?.recent_removals ?? [];
	const invites = pendingInvites ?? [];

	// No single-org redirect here (it's in RootRedirect), so this list stays
	// reachable for single-org users.
	const orgList = deriveOrgList(organisations, workspaces);

	if (isLoading) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" gap={16} mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	// Distinct from the empty-state branch below — a 5xx is not "no access."
	if (isError) {
		return (
			<FetchErrorPanel
				onRetry={() => refetch()}
				message={
					<Trans>
						We couldn't load your organisations. Check your connection and try
						again.
					</Trans>
				}
			/>
		);
	}

	return (
		<Container size="sm" py="xl" px="lg">
			<Stack gap={24}>
				<Title order={3} fw={400}>
					<Trans>Organisations</Trans>
				</Title>

				{orgList.length > 0 ? (
					<Stack gap="sm">
						{orgList.map((org) => (
							<OrgRow
								key={org.id}
								org={org}
								onOpen={() => navigate(`/o/${org.id}/overview`)}
							/>
						))}
					</Stack>
				) : invites.length > 0 ? (
					<Stack align="center" gap={12} mt="10vh">
						<Text c="dimmed" size="sm" ta="center">
							{invites[0].type === "org" ? (
								<Trans>
									You have a pending invite to {invites[0].org_name}. Open it to
									join the organisation.
								</Trans>
							) : (
								<Trans>
									You have a pending invite to{" "}
									{invites[0].workspace_name ?? "a workspace"}. The admin needs
									to free a seat before you can join.
								</Trans>
							)}
						</Text>
						<Button
							variant="outline"
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
							<Trans>Contact the admin if this was unexpected.</Trans>
						</Text>
					</Stack>
				) : (
					<Stack align="center" gap={8} mt="10vh">
						<Text c="dimmed" size="sm" ta="center">
							<Trans>You're not part of any organisation right now.</Trans>
						</Text>
						<Text c="dimmed" size="sm" ta="center">
							<Trans>
								If you were expecting access, please ask the person who invited
								you to send it again.
							</Trans>
						</Text>
					</Stack>
				)}
			</Stack>
		</Container>
	);
};
