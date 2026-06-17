import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AppWindowIcon, FolderIcon, Folders, GearIcon, UsersIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "react-router";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useSidebarView } from "../../hooks/useSidebarView";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";
import { SectionLabel } from "../../primitives/SectionLabel";

interface OrgWorkspaceRow {
	id: string;
	name: string;
}

async function fetchOrgWorkspaces(
	orgId: string,
): Promise<OrgWorkspaceRow[] | null> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/workspaces`, {
		credentials: "include",
	});
	if (res.status === 401 || res.status === 403 || res.status === 404) {
		return null;
	}
	if (!res.ok) {
		throw new Error(`workspaces ${res.status}`);
	}
	return (await res.json()) as OrgWorkspaceRow[];
}

export const OrgHomeView = () => {
	const { orgId: routeOrgId, organisationId } = useParams<{
		orgId?: string;
		organisationId?: string;
	}>();
	// On /w/new (request-workspace) the org isn't a path param — it rides in on
	// the query string and is surfaced through the resolved sidebar view.
	const { params: sidebarParams } = useSidebarView();
	const orgId = routeOrgId ?? organisationId ?? sidebarParams.orgId;
	const { workspaces: myWorkspaces } = useWorkspace();
	const { data: me } = useV2Me();
	const isManager = useMemo(() => {
		const role = me?.orgs.find((o) => o.id === orgId)?.role;
		return role === "admin" || role === "owner";
	}, [me, orgId]);

	const myOrgWorkspaces = useMemo(
		() => myWorkspaces.filter((w) => w.org_id === orgId),
		[myWorkspaces, orgId],
	);

	const orgWsQuery = useQuery({
		enabled: Boolean(orgId),
		queryFn: async () => fetchOrgWorkspaces(orgId as string),
		// Shared namespace with OrganisationRoute; mutations affecting org workspaces must invalidate THIS key (not `["v2", "orgs", ...]`).
		queryKey: ["v2", "organisation", orgId, "workspaces"],
		retry: false,
		staleTime: 30_000,
	});

	const isExternal =
		orgWsQuery.data === null ||
		(myOrgWorkspaces.length > 0 &&
			myOrgWorkspaces.every((w) => w.role === "external"));

	const orgName =
		myOrgWorkspaces[0]?.org_name ??
		me?.orgs.find((o) => o.id === orgId)?.name ??
		t`Organisation`;

	const displayList = useMemo(() => {
		// Admins/owners see the whole org roster (they can open any workspace).
		// Everyone else (member, billing, external) sees only the workspaces
		// they directly belong to, so the sidebar never shows a workspace that
		// dead-links on click. Discovering other workspaces happens on /o.
		if (!isManager) {
			return myOrgWorkspaces.map((w) => ({
				id: w.id,
				isExternal: w.role === "external",
				name: w.name,
			}));
		}
		const externalSet = new Set(
			myOrgWorkspaces.filter((w) => w.role === "external").map((w) => w.id),
		);
		const full = orgWsQuery.data;
		if (full && full.length > 0) {
			return full.map((w) => ({
				id: w.id,
				isExternal: externalSet.has(w.id),
				name: w.name,
			}));
		}
		return myOrgWorkspaces.map((w) => ({
			id: w.id,
			isExternal: w.role === "external",
			name: w.name,
		}));
	}, [isManager, myOrgWorkspaces, orgWsQuery.data]);

	// Show the Workspaces section whenever there is something to show — for
	// managers that is the full org list, for everyone else their direct rows.
	const showWorkspaces = displayList.length > 0;

	if (!orgId) return null;
	const base = `/o/${orgId}`;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			{/* The back button doubles as the section title: its centered label is
			    the org name (the current context), not the destination. */}
			<BackButton to="/o" label={orgName} center />

			{!isExternal && (
				<>
						<NavItem
							to={`${base}/overview`}
							label={<Trans>Overview</Trans>}
							icon={AppWindowIcon}
							end
						/>
						<NavItem
							to={`${base}/settings/members`}
							label={<Trans>Members</Trans>}
							icon={UsersIcon}
						/>
						{/* Settings is the last clickable item under the org title,
						    directly below Overview and above the Workspaces section. */}
						<NavItem
							to={`${base}/settings/general`}
							label={<Trans>Settings</Trans>}
							icon={GearIcon}
							pushes
						/>
				</>
			)}

			{showWorkspaces && (
				<>
					<SectionLabel>
						<Trans>Workspaces</Trans>
					</SectionLabel>
						{displayList.map((ws) => (
							<NavItem
								key={ws.id}
								to={`/w/${ws.id}/home`}
								label={ws.name}
								icon={Folders}
								badge={ws.isExternal ? <Trans>External</Trans> : undefined}
								pushes
							/>
						))}
				</>
			)}
		</nav>
	);
};
